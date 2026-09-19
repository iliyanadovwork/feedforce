import { describe, it, expect, beforeEach, vi } from 'vitest';

// mediaCleanup PERMANENTLY deletes Storage objects. These tests pin the safety invariants its own
// comments document: (1) reference scans read EVERY PostgREST page — a truncated scan counts a live
// file as dead and deletes user media; (2) if ANY scan fails, the sweep aborts and deletes nothing;
// (3) only candidates no surviving row references are removed, with `liveReels` substituting for the
// (possibly stale, debounce-lagged) video_reels DB row.

const h = vi.hoisted(() => {
  // Per-table dataset. `errorAtOffset`: any range request starting at/after this offset errors,
  // letting tests fail either the first page or a LATER page mid-pagination.
  const tables = new Map<string, { rows: unknown[]; errorAtOffset?: number }>();
  const rangeCalls: Array<{ table: string; columns: string; orderBy: string; from: number; to: number }> = [];
  const removeCalls: Array<{ bucket: string; paths: string[] }> = [];
  const from = vi.fn((table: string) => ({
    select: (columns: string) => ({
      order: (orderBy: string) => ({
        // Mirrors real supabase-js/PostgREST .range(from, to): zero-based offsets, BOTH ends
        // inclusive (limit = to - from + 1). Serving slices of one flat array means overlapping or
        // gapping page math in production would show up as duplicated/missing rows here.
        range: async (from_: number, to: number) => {
          rangeCalls.push({ table, columns, orderBy, from: from_, to });
          const t = tables.get(table) ?? { rows: [] };
          if (t.errorAtOffset !== undefined && from_ >= t.errorAtOffset) {
            return { data: null, error: { message: 'scan failed' } };
          }
          return { data: t.rows.slice(from_, to + 1), error: null };
        },
      }),
    }),
  }));
  const storageFrom = vi.fn((bucket: string) => ({
    remove: async (paths: string[]) => {
      removeCalls.push({ bucket, paths });
      return { data: null, error: null };
    },
  }));
  return { tables, rangeCalls, removeCalls, from, storageFrom };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: h.from, storage: { from: h.storageFrom } },
}));

import { collectMediaRefs, cleanupMediaRefs } from './mediaCleanup';

const PUB = 'https://xyz.supabase.co/storage/v1/object/public';
const url = (bucket: string, path: string) => `${PUB}/${bucket}/${path}`;
const slideRow = (u: string) => ({ image_boxes: [{ imageUrl: u }], free_elements: [] });
const filler = (n: number) => Array.from({ length: n }, () => ({ image_boxes: [], free_elements: [] }));

beforeEach(() => {
  h.tables.clear();
  h.rangeCalls.length = 0;
  h.removeCalls.length = 0;
  h.from.mockClear();
  h.storageFrom.mockClear();
});

describe('collectMediaRefs', () => {
  it('deep-scans nested JSON for both media buckets and dedupes to bucket/path refs', () => {
    const refs = collectMediaRefs({
      slides: [
        { image_boxes: [{ imageUrl: url('post-images', 'u1/a.png') }] },
        { free_elements: [{ src: url('post-videos', 'u1/clip.mp4') }] },
        { deeper: { copiedFrom: url('post-images', 'u1/a.png') } }, // duplicate URL → one ref
      ],
    });
    expect(refs).toEqual(new Set(['post-images/u1/a.png', 'post-videos/u1/clip.mp4']));
  });

  it('strips query strings and hash fragments from the path', () => {
    expect(collectMediaRefs(`${url('post-images', 'u1/a.png')}?token=abc&w=300`))
      .toEqual(new Set(['post-images/u1/a.png']));
    expect(collectMediaRefs(`${url('post-images', 'u1/a.png')}#frag`))
      .toEqual(new Set(['post-images/u1/a.png']));
  });

  it('decodes percent-encoded paths so refs match real storage object names', () => {
    expect(collectMediaRefs(url('post-images', 'u1/My%20File%20(1).png')))
      .toEqual(new Set(['post-images/u1/My File (1).png']));
  });

  it('skips /_renders/ paths (schedule-time bakes owned by the scheduled_render_media ledger)', () => {
    expect(collectMediaRefs(url('post-videos', 'u1/_renders/reel.mp4'))).toEqual(new Set());
  });

  it('ignores non-media-bucket URLs, signed URLs, empty paths and non-string values', () => {
    expect(collectMediaRefs([
      'https://xyz.supabase.co/storage/v1/object/public/avatars/u1/a.png',        // other bucket
      'https://xyz.supabase.co/storage/v1/object/public/post-images-old/a.png',   // prefix collision
      'https://xyz.supabase.co/storage/v1/object/sign/post-images/u1/a.png',      // signed, not public
      'https://example.com/post-images/a.png',                                     // not storage
      url('post-images', ''),                                                      // marker, empty path
      42, null, undefined, true,
    ])).toEqual(new Set());
  });
});

describe('cleanupMediaRefs — pagination (truncated scan = deleted live media)', () => {
  it('collects refs found ONLY past the first 1000-row page and keeps those files', async () => {
    // 1001 rows: the sole reference to live-late.png sits on PostgREST page 2. If the scan stopped
    // at the default first page, live-late.png would be counted dead and irreversibly deleted.
    h.tables.set('template_editor_slides', { rows: [...filler(1000), slideRow(url('post-images', 'u1/live-late.png'))] });
    await cleanupMediaRefs(new Set(['post-images/u1/live-late.png', 'post-images/u1/dead.png']));
    expect(h.removeCalls).toEqual([{ bucket: 'post-images', paths: ['u1/dead.png'] }]);
  });

  it('pages with inclusive 1000-row ranges and a stable ORDER BY on every request', async () => {
    h.tables.set('template_editor_slides', { rows: [...filler(1000), slideRow(url('post-images', 'u1/x.png'))] });
    await cleanupMediaRefs(new Set(['post-images/u1/dead.png']));
    const calls = h.rangeCalls.filter(c => c.table === 'template_editor_slides');
    expect(calls.map(c => [c.from, c.to])).toEqual([[0, 999], [1000, 1999]]);
    // LIMIT/OFFSET without ORDER BY can shift rows between pages (skip/duplicate one), silently
    // dropping a live ref — every page request must order by the table's stable unique key.
    expect(calls.every(c => c.orderBy === 'id')).toBe(true);
    expect(h.rangeCalls.filter(c => c.table === 'video_reels').map(c => c.orderBy)).toEqual(['user_id']);
  });

  it('scans all five reference tables when liveReels is not passed', async () => {
    await cleanupMediaRefs(new Set(['post-images/u1/dead.png']));
    expect(new Set(h.rangeCalls.map(c => c.table))).toEqual(new Set([
      'template_editor_slides', 'template_editor_post_slides', 'twitter_templates', 'video_reels', 'reel_sheets',
    ]));
    // The sheet scan pages with a stable order key like every other reference table.
    const sheetCalls = h.rangeCalls.filter(c => c.table === 'reel_sheets');
    expect(sheetCalls.every(c => c.columns === 'rows' && c.orderBy === 'sheet_id')).toBe(true);
  });

  it('a table with exactly 1000 rows fetches one more (empty) page and terminates', async () => {
    h.tables.set('twitter_templates', { rows: Array.from({ length: 1000 }, () => ({ settings: {} })) });
    await cleanupMediaRefs(new Set(['post-images/u1/dead.png']));
    const calls = h.rangeCalls.filter(c => c.table === 'twitter_templates');
    expect(calls.map(c => [c.from, c.to])).toEqual([[0, 999], [1000, 1999]]);
    expect(h.removeCalls).toEqual([{ bucket: 'post-images', paths: ['u1/dead.png'] }]);
  });
});

describe('cleanupMediaRefs — abort on any scan failure', () => {
  it('deletes NOTHING when any scan errors on its first page (with negative control)', async () => {
    h.tables.set('twitter_templates', { rows: [], errorAtOffset: 0 });
    await cleanupMediaRefs(new Set(['post-images/u1/dead.png']));
    expect(h.storageFrom).not.toHaveBeenCalled();
    expect(h.removeCalls).toEqual([]);
    // Negative control: the identical sweep WITHOUT the error deletes the dead file — proving the
    // no-delete assertion above is the abort path, not a vacuously idle mock.
    h.tables.delete('twitter_templates');
    await cleanupMediaRefs(new Set(['post-images/u1/dead.png']));
    expect(h.removeCalls).toEqual([{ bucket: 'post-images', paths: ['u1/dead.png'] }]);
  });

  it('deletes NOTHING when a LATER page errors mid-pagination (a partial scan proves no file unused)', async () => {
    h.tables.set('template_editor_slides', { rows: filler(1000), errorAtOffset: 1000 });
    await cleanupMediaRefs(new Set(['post-images/u1/dead.png']));
    expect(h.storageFrom).not.toHaveBeenCalled();
    expect(h.removeCalls).toEqual([]);
    // Page 1 succeeded before page 2 failed — the abort came from the mid-scan failure.
    expect(h.rangeCalls.filter(c => c.table === 'template_editor_slides')).toHaveLength(2);
  });
});

describe('cleanupMediaRefs — liveness and the liveReels substitution', () => {
  it('does nothing at all for an empty candidate set', async () => {
    await cleanupMediaRefs(new Set());
    expect(h.from).not.toHaveBeenCalled();
    expect(h.storageFrom).not.toHaveBeenCalled();
  });

  it('keeps candidates a surviving row still references; deletes the rest batched per bucket', async () => {
    h.tables.set('template_editor_post_slides', { rows: [slideRow(url('post-images', 'u1/keep.png'))] });
    await cleanupMediaRefs(new Set([
      'post-images/u1/keep.png',   // still referenced → must survive
      'post-images/u1/dead-a.png',
      'post-images/u1/dead-b.png',
      'post-videos/u1/dead.mp4',
    ]));
    expect(h.removeCalls).toEqual([
      { bucket: 'post-images', paths: ['u1/dead-a.png', 'u1/dead-b.png'] },
      { bucket: 'post-videos', paths: ['u1/dead.mp4'] },
    ]);
  });

  it('liveReels substitutes for the video_reels fetch — the stale DB row is never consulted', async () => {
    // Poison the DB row: it still references dead.mp4 (the debounced save hasn't landed). If cleanup
    // wrongly fetched video_reels anyway, dead.mp4 would be counted alive and this test would fail.
    h.tables.set('video_reels', { rows: [{ reels: [{ videoUrl: url('post-videos', 'u1/dead.mp4') }] }] });
    const liveReels = [{ videoUrl: url('post-videos', 'u1/keep.mp4') }];
    await cleanupMediaRefs(new Set(['post-videos/u1/keep.mp4', 'post-videos/u1/dead.mp4']), liveReels);
    expect(h.from).not.toHaveBeenCalledWith('video_reels');
    // keep.mp4 is alive purely via liveReels; dead.mp4 goes despite the stale DB reference.
    expect(h.removeCalls).toEqual([{ bucket: 'post-videos', paths: ['u1/dead.mp4'] }]);
  });

  it('CONTROL — without liveReels the video_reels row IS fetched and its refs count as alive', async () => {
    // Gives the not.toHaveBeenCalledWith('video_reels') assertion above real teeth.
    h.tables.set('video_reels', { rows: [{ reels: [{ videoUrl: url('post-videos', 'u1/still-used.mp4') }] }] });
    await cleanupMediaRefs(new Set(['post-videos/u1/still-used.mp4']));
    expect(h.from).toHaveBeenCalledWith('video_reels');
    expect(h.removeCalls).toEqual([]);
  });

  it('a Content Sheet row referencing an uploaded video keeps it alive (reel-side GC cannot delete it)', async () => {
    // Sheet upload sent to reels, reel later deleted: the reel's GC candidates include the video, but
    // the sheet's Link cell still points at it — the reel_sheets scan must count it alive. (This scan
    // is the sheet's ONLY GC involvement: protection, never deletion — sheet mutations don't sweep.)
    h.tables.set('reel_sheets', { rows: [{ rows: [{ id: 'r1', link: url('post-videos', 'u1/sheet-upload.mp4') }] }] });
    await cleanupMediaRefs(new Set(['post-videos/u1/sheet-upload.mp4']), [] /* liveReels: reel already gone */);
    expect(h.removeCalls).toEqual([]);
  });
});
