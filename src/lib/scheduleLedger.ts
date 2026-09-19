import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { MediaItem } from '@/lib/zernio';

// ── Render-cleanup ledger ─────────────────────────────────────────────────────────────────────────
// Media URLs pointing at `_renders/` files in our own buckets are schedule-time bakes (throwaway,
// Instagram fetches the URL at publish time and hosts its own copy). The SERVER ledgers them for the
// cleanup cron right after Zernio accepts the post: the browser used to do this after the fact, so a
// tab dying post-Zernio orphaned the files forever (nothing else sweeps `_renders/`).
// Shared by the single-post and bulk schedule routes (lifted verbatim from /api/schedule/post).

const RENDER_BUCKETS = ['post-images', 'post-videos'] as const;

/** Public storage URL → { bucket, path } when it's a `_renders/` bake in OUR buckets (else null).
 *  Mirrors lib/mediaCleanup's marker parsing. */
export function renderStoragePath(url: string): { bucket: string; path: string } | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (!base || !url.startsWith(base)) return null;
  for (const bucket of RENDER_BUCKETS) {
    const marker = `/storage/v1/object/public/${bucket}/`;
    const at = url.indexOf(marker);
    if (at === -1) continue;
    const path = decodeURIComponent(url.slice(at + marker.length).split(/[?#]/)[0]);
    if (path && path.includes('/_renders/')) return { bucket, path };
  }
  return null;
}

// Swap the browser's pre-post `pending_*` safety rows for rows keyed by the Zernio post id (cancel
// deletes them by that key; the cron sweeps them after publish). Expiry mirrors serverPublish:
// publish-now ≈ minutes until Instagram has its copy; scheduled = publish time + buffer. Best-effort:
// the post is already placed, a ledger hiccup must not fail the request.
export async function ledgerRenders(userId: string, postId: string, mediaItems: MediaItem[], expiresAtMs: number) {
  try {
    const refs = mediaItems.map(m => renderStoragePath(m.url)).filter((r): r is { bucket: string; path: string } => r !== null);
    if (!refs.length) return;
    const db = supabaseAdmin();
    await db.from('scheduled_render_media').delete().eq('user_id', userId).like('post_id', 'pending%').in('path', refs.map(r => r.path));
    const { error } = await db.from('scheduled_render_media').insert(refs.map(r => ({
      user_id: userId, post_id: postId, bucket: r.bucket, path: r.path,
      expires_at: new Date(expiresAtMs).toISOString(),
    })));
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[scheduleLedger] ledgerRenders failed:', e instanceof Error ? e.message : e);
  }
}
