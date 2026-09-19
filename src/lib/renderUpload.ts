import { supabase } from './supabase';

// Client-side upload of a baked render (a schedule-time MP4/PNG bake) into one of our public media
// buckets, under the user's `_renders/` folder. These files are throwaway: Instagram fetches the URL
// at publish time and hosts its own copy, and the cleanup cron sweeps `_renders/` via the
// scheduled_render_media ledger. Lifted from SchedulePanel's Composer so the Schedule All engine and
// the Composer share one upload path.

export type RenderBucket = 'post-images' | 'post-videos';

// Supabase's project-wide upload cap (50 MiB; post-videos has no per-bucket override). Checked BEFORE
// dispatch so an oversized render gets an actionable message instead of an opaque storage 400. The
// reel exporter budgets its bitrate to stay under this (useRecording), so tripping it is exceptional.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type RenderUploadResult =
  | { ok: true; url: string; bucket: RenderBucket; path: string }
  | { ok: false; message: string };

/** Shared upload core: sign-in + size-cap guards, the upload, and error-message shaping — one copy,
 *  so a message/retry fix can't land in one upload path and miss the others (the throwaway `_renders/`
 *  bakes AND the durable user uploads both route through here; only the `path` differs). */
export async function uploadMediaBlob(
  userId: string,
  bucket: RenderBucket,
  blob: Blob,
  path: string,          // full storage path; first segment must be the uid (bucket RLS)
  contentType: string,
): Promise<RenderUploadResult> {
  if (!userId) return { ok: false, message: 'You need to be signed in to upload.' };
  if (blob.size > MAX_UPLOAD_BYTES) {
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    const cap = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);
    // Media-neutral copy: this helper also uploads carousel slide PNGs, so no reel-specific advice here.
    return { ok: false, message: `This file is ${mb} MB, over the ${cap} MB upload limit. Make it smaller (for a reel: trim it shorter) and try again.` };
  }
  const { error } = await supabase.storage.from(bucket).upload(path, blob, { contentType });
  if (error) {
    console.error('[renderUpload]', bucket, path, error.message);
    return { ok: false, message: `Upload failed: ${error.message}` };
  }
  return { ok: true, url: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl, bucket, path };
}

/** Upload a rendered media blob to a public bucket. Returns its https URL plus the exact storage
 *  path (recorded in the cleanup ledger), or `{ ok: false }` with a user-facing message. Failures
 *  were previously collapsed to a bare null, which made a size-cap 400, an RLS 403, and a network
 *  drop all read "Failed to upload" with nothing to act on (incident 2026-07-19). */
export async function uploadRenderBlob(
  userId: string,
  bucket: RenderBucket,
  blob: Blob,
  name: string,
  contentType: string,
): Promise<RenderUploadResult> {
  return uploadMediaBlob(userId, bucket, blob, `${userId}/_renders/${name}`, contentType);
}
