import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Locks the render-cleanup ledger shared by the single and bulk schedule routes (lifted from
// /api/schedule/post, so this also guards against drift during the extraction): renderStoragePath
// must only match `_renders/` bakes in OUR buckets (query/hash stripped, percent-decoding applied),
// and ledgerRenders must swap the browser's `pending_*` safety rows for post-id-keyed rows, skip the
// DB entirely when no render URLs are present, and NEVER throw (the post is already placed upstream,
// a ledger hiccup must not fail the request).

interface DeleteCall { table: string; eq: unknown[]; like: unknown[]; in: unknown[] }
interface InsertCall { table: string; rows: unknown }

const db = vi.hoisted(() => ({
  deleteCalls: [] as DeleteCall[],
  insertCalls: [] as InsertCall[],
  insertError: null as { message: string } | null,
  throwOnFrom: false,
}));

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (db.throwOnFrom) throw new Error('db down');
      return {
        delete: () => {
          const call: DeleteCall = { table, eq: [], like: [], in: [] };
          db.deleteCalls.push(call);
          const chain = {
            eq: (...a: unknown[]) => { call.eq = a; return chain; },
            like: (...a: unknown[]) => { call.like = a; return chain; },
            in: (...a: unknown[]) => { call.in = a; return chain; },
            then: (onOk?: (v: { data: unknown[]; error: null }) => unknown, onErr?: (e: unknown) => unknown) =>
              Promise.resolve({ data: [] as unknown[], error: null }).then(onOk, onErr),
          };
          return chain;
        },
        insert: (rows: unknown) => {
          db.insertCalls.push({ table, rows });
          return Promise.resolve({ error: db.insertError });
        },
      };
    },
  }),
}));

import { renderStoragePath, ledgerRenders } from '@/lib/scheduleLedger';
import type { MediaItem } from '@/lib/zernio';

const BASE = 'https://unit-test.supabase.co';
const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

function videoUrl(path: string) {
  return `${BASE}/storage/v1/object/public/post-videos/${path}`;
}
function media(url: string): MediaItem {
  return { type: 'video', url };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  db.deleteCalls = [];
  db.insertCalls = [];
  db.insertError = null;
  db.throwOnFrom = false;
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
});

describe('renderStoragePath', () => {
  it('parses a post-videos _renders bake into { bucket, path }', () => {
    expect(renderStoragePath(videoUrl('u1/_renders/reel.mp4')))
      .toEqual({ bucket: 'post-videos', path: 'u1/_renders/reel.mp4' });
  });

  it('parses a post-images _renders bake', () => {
    expect(renderStoragePath(`${BASE}/storage/v1/object/public/post-images/u1/_renders/slide.png`))
      .toEqual({ bucket: 'post-images', path: 'u1/_renders/slide.png' });
  });

  it('strips query strings and fragments from the path', () => {
    expect(renderStoragePath(videoUrl('u1/_renders/reel.mp4') + '?token=abc#t=5'))
      .toEqual({ bucket: 'post-videos', path: 'u1/_renders/reel.mp4' });
  });

  it('percent-decodes the path', () => {
    expect(renderStoragePath(videoUrl('u1/_renders/my%20reel.mp4')))
      .toEqual({ bucket: 'post-videos', path: 'u1/_renders/my reel.mp4' });
  });

  it('returns null for our bucket outside _renders/ (user library files are not throwaway)', () => {
    expect(renderStoragePath(videoUrl('u1/uploads/keeper.mp4'))).toBeNull();
  });

  it('returns null for a foreign host, even with a lookalike path', () => {
    expect(renderStoragePath('https://evil.example.com/storage/v1/object/public/post-videos/u1/_renders/reel.mp4')).toBeNull();
  });

  it('returns null for our host but a non-render bucket', () => {
    expect(renderStoragePath(`${BASE}/storage/v1/object/public/avatars/u1/_renders/pic.png`)).toBeNull();
  });

  it('returns null when NEXT_PUBLIC_SUPABASE_URL is unset (never matches by accident)', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(renderStoragePath(videoUrl('u1/_renders/reel.mp4'))).toBeNull();
  });
});

describe('ledgerRenders', () => {
  it('ledgers only the render URLs: clears matching pending_* rows, then inserts post-keyed rows', async () => {
    const expires = Date.parse('2999-01-01T16:00:00.000Z');
    await ledgerRenders('u1', 'post-9', [
      media(videoUrl('u1/_renders/reel.mp4')),
      media('https://cdn.example.com/external.mp4'), // not ours → not ledgered
    ], expires);

    expect(db.deleteCalls).toEqual([{
      table: 'scheduled_render_media',
      eq: ['user_id', 'u1'],
      like: ['post_id', 'pending%'],
      in: ['path', ['u1/_renders/reel.mp4']],
    }]);
    expect(db.insertCalls).toEqual([{
      table: 'scheduled_render_media',
      rows: [{
        user_id: 'u1', post_id: 'post-9', bucket: 'post-videos', path: 'u1/_renders/reel.mp4',
        expires_at: new Date(expires).toISOString(),
      }],
    }]);
  });

  it('skips the DB entirely when no media item is a render bake', async () => {
    await ledgerRenders('u1', 'post-9', [media('https://cdn.example.com/external.mp4')], Date.now());
    expect(db.deleteCalls).toEqual([]);
    expect(db.insertCalls).toEqual([]);
  });

  it('an insert error is swallowed (best-effort): warns, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.insertError = { message: 'insert exploded' };
      await expect(ledgerRenders('u1', 'post-9', [media(videoUrl('u1/_renders/reel.mp4'))], Date.now()))
        .resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing client is swallowed too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.throwOnFrom = true;
      await expect(ledgerRenders('u1', 'post-9', [media(videoUrl('u1/_renders/reel.mp4'))], Date.now()))
        .resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
