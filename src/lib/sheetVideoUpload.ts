import { uploadMediaBlob } from './renderUpload';
import { requestUpgrade, upgradeReasonForDbError } from './upgradePrompt';

// Direct video uploads from the reels Content Sheet (the per-row "Upload video" button). The file
// goes into the SAME durable namespace as canvas reel uploads (`{uid}/{ts}_{name}` in post-videos —
// NOT `_renders/`, which the cleanup cron sweeps), and its public URL becomes the row's Link cell.
// Downstream already understands that URL: send-to-reels sets it as the entry's stored videoUrl
// (played straight from our bucket, exactly like a restored uploaded reel) instead of handing it to
// /api/download, which only speaks TikTok/Instagram/X; and mediaCleanup scans reel_sheets, so a
// reel-side GC can never delete a file a sheet row still references.

const UPLOADED_MARKER = '/storage/v1/object/public/post-videos/';

/** Is this link a DURABLE upload of ours (a post-videos public URL outside `_renders/`)? `_renders/`
 *  files are throwaway schedule-time bakes: the cleanup cron sweeps them and the media GC refuses to
 *  track them, so a pasted `_renders/` URL must be treated as a plain (doomed) link, never as a
 *  stored video. */
export function isUploadedVideoUrl(link: string): boolean {
  const at = link.indexOf(UPLOADED_MARKER);
  if (at === -1) return false;
  const path = link.slice(at + UPLOADED_MARKER.length).split(/[?#]/)[0];
  return !path.includes('/_renders/');
}

/** Human name for an uploaded video's URL: the stored filename minus our `{timestamp}_` prefix. */
export function uploadedVideoDisplayName(link: string): string {
  const path = link.slice(link.indexOf(UPLOADED_MARKER) + UPLOADED_MARKER.length).split(/[?#]/)[0];
  let name = path.split('/').pop() ?? '';
  try { name = decodeURIComponent(name); } catch { /* keep the raw segment */ }
  name = name.replace(/^\d+_/, '');
  return name || 'uploaded video';
}

export type SheetVideoUploadResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/** Upload a user-picked video file into the durable post-videos namespace; returns its public URL or
 *  a user-facing message. Shared by the Content Sheet's per-row upload and the timeline's added
 *  sources. Path convention matches CanvasGrid.persistUpload so all durable uploads age identically. */
export async function uploadDurableVideo(userId: string, file: File): Promise<SheetVideoUploadResult> {
  const safe = (file.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'reel').slice(0, 100);
  const result = await uploadMediaBlob(userId, 'post-videos', file, `${userId}/${Date.now()}_${safe}`, file.type || 'video/mp4');
  if (!result.ok) {
    // A free-plan storage-quota rejection deserves the upgrade prompt, not just an error line.
    const upgrade = upgradeReasonForDbError(result.message);
    if (upgrade) requestUpgrade(upgrade);
    return result;
  }
  return { ok: true, url: result.url };
}

/** The Content Sheet's per-row upload (kept as its own name so call sites read as intent). */
export const uploadSheetVideo = uploadDurableVideo;
