import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { cronAuthorized as authorized } from '@/lib/cronAuth';

export const runtime = 'nodejs';

// Deletes baked schedule-time media renders (reel MP4s / carousel PNGs) once they're safe to drop —
// i.e. past their expires_at (publish time + buffer). Instagram has its own copy by then, so ours is
// dead weight. Called by a scheduler (e.g. Vercel Cron) on an interval; gated by CRON_SECRET. Best-effort.
// See production/supabase/scheduled_render_media.sql.

const BATCH = 500;

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = supabaseAdmin();

  // Housekeeping piggybacked on this hourly cron: prune rate-limit windows that closed over a day ago
  // (see supabase/rate_limits.sql). Best-effort.
  const { error: rlErr } = await db.from('rate_limits').delete().lt('reset_at', new Date(Date.now() - 24 * 3600_000).toISOString());
  if (rlErr) console.warn('[cleanup-renders] rate_limits prune failed:', rlErr.message);

  // Also sweep day-old ephemeral posts (throwaway automation-run snapshots; slides cascade). The client
  // deletes them right after publishing — this catches cron-triggered runs and abandoned/interrupted
  // ones. Best-effort: a failure here must not block the media cleanup below.
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { error: ephErr } = await db.from('template_editor_posts').delete().eq('ephemeral', true).lt('created_at', dayAgo);
  if (ephErr) console.warn('[cleanup-renders] ephemeral post sweep failed:', ephErr.message);

  const nowIso = new Date().toISOString();
  const { data: rows, error } = await db
    .from('scheduled_render_media')
    .select('id,bucket,path')
    .lt('expires_at', nowIso)
    .limit(BATCH);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ removed: 0 });

  // Group paths per bucket, remove the storage objects, then drop the ledger rows we handled.
  const byBucket = new Map<string, string[]>();
  for (const r of rows as { id: string; bucket: string; path: string }[]) {
    const arr = byBucket.get(r.bucket) ?? [];
    arr.push(r.path);
    byBucket.set(r.bucket, arr);
  }
  for (const [bucket, paths] of byBucket) {
    const { error: rmErr } = await db.storage.from(bucket).remove(paths);
    if (rmErr) console.warn(`[cleanup-renders] storage remove failed for ${bucket}:`, rmErr.message);
  }

  const ids = (rows as { id: string }[]).map(r => r.id);
  const { error: delErr } = await db.from('scheduled_render_media').delete().in('id', ids);
  if (delErr) return NextResponse.json({ error: delErr.message, removedFromStorage: ids.length }, { status: 500 });

  return NextResponse.json({ removed: ids.length });
}
