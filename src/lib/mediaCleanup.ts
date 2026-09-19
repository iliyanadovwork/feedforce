import { supabase } from '@/lib/supabase';

// GC for pasted/uploaded editor media (the post-images / post-videos buckets).
//
// Files are uploaded once and then referenced by PUBLIC URL inside JSONB — carousel/template slides
// (image_boxes, free_elements), reel templates (twitter_templates.settings), the reels workspace
// (video_reels.reels) and the Content Sheet backlog (reel_sheets.rows, whose Link cells can hold a
// sheet-uploaded video's URL). Duplicating a template/slide or creating a post from a template copies the
// URLs, NOT the files, so several rows can point at one storage object. Deleting an entity therefore
// can't just delete "its" files: collect the refs the deleted rows held, then remove only the ones no
// surviving row references.
//
// Best-effort by design: a failed sweep leaves an orphaned file (invisible; only costs storage),
// never a broken image. If ANY reference scan fails we abort — we can't prove a file is unused.

const MEDIA_BUCKETS = ['post-images', 'post-videos'] as const;

/** Deep-scan any JSON-ish value for public URLs in our media buckets → unique `bucket/path` refs. */
export function collectMediaRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const bucket of MEDIA_BUCKETS) {
      const marker = `/storage/v1/object/public/${bucket}/`;
      const at = value.indexOf(marker);
      if (at === -1) continue;
      const path = decodeURIComponent(value.slice(at + marker.length).split(/[?#]/)[0]);
      // `_renders/` files are schedule-time bakes owned by the scheduled_render_media ledger — skip.
      if (path && !path.includes('/_renders/')) out.add(`${bucket}/${path}`);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectMediaRefs(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectMediaRefs(v, out);
  }
  return out;
}

// Fetch EVERY row of a reference table, not just PostgREST's default first page (1000). A truncated
// scan would omit references a later row still holds, so cleanupMediaRefs would count a live file as
// dead and delete it. Returns null on any page error → the caller aborts and deletes nothing (a partial
// scan can never prove a file is unused). RLS scopes each page to the caller's own rows.
async function selectAllRefs(table: string, columns: string, orderBy: string): Promise<unknown[] | null> {
  const PAGE = 1000;
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    // Order by a stable unique key: LIMIT/OFFSET pagination without ORDER BY can shift rows between
    // pages (skipping or duplicating one), which would drop a live ref and delete a referenced file.
    const { data, error } = await supabase.from(table).select(columns).order(orderBy).range(from, from + PAGE - 1);
    if (error) return null;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Delete the candidate files that nothing in the user's content references anymore (RLS scopes every
 *  scan to the caller's rows). `liveReels` substitutes for the video_reels fetch when the caller holds
 *  newer, not-yet-saved reels state (that save is debounced, so the DB row can still list a deleted reel).
 *  reel_sheets is scan-only PROTECTION: sheet rows referencing an uploaded video keep it alive, but no
 *  sheet-side mutation ever calls this to delete — a sheet's own autosave is debounced, so an eager
 *  sheet-side sweep would race it and could delete files the live state still references (worse than
 *  the orphan it would reclaim). Sheet-abandoned uploads are accepted orphans, like link re-edits. */
export async function cleanupMediaRefs(candidates: Set<string>, liveReels?: unknown): Promise<void> {
  if (!candidates.size) return;
  const [tplSlides, postSlides, twitterTpls, reels, sheets] = await Promise.all([
    selectAllRefs('template_editor_slides', 'image_boxes,free_elements', 'id'),
    selectAllRefs('template_editor_post_slides', 'image_boxes,free_elements', 'id'),
    selectAllRefs('twitter_templates', 'settings', 'id'),
    // When the caller passes liveReels, use that instead of the (stale) DB row — no fetch needed.
    liveReels === undefined ? selectAllRefs('video_reels', 'reels', 'user_id') : Promise.resolve<unknown[]>([]),
    selectAllRefs('reel_sheets', 'rows', 'sheet_id'),
  ]);
  // If ANY scan failed (null), abort: deleting on a partial scan could remove a still-referenced file.
  if (!tplSlides || !postSlides || !twitterTpls || !reels || !sheets) return;
  const alive = collectMediaRefs([tplSlides, postSlides, twitterTpls, reels, liveReels, sheets]);

  const byBucket = new Map<string, string[]>();
  for (const ref of candidates) {
    if (alive.has(ref)) continue;
    const slash = ref.indexOf('/');
    byBucket.set(ref.slice(0, slash), [...(byBucket.get(ref.slice(0, slash)) ?? []), ref.slice(slash + 1)]);
  }
  for (const [bucket, paths] of byBucket) await supabase.storage.from(bucket).remove(paths);
}
