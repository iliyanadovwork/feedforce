import { describe, it, expect } from 'vitest';
import { isUploadedVideoUrl, uploadedVideoDisplayName } from './sheetVideoUpload';

// The URL predicates that route a sheet row at send-to-reels time: an uploaded video's bucket URL
// becomes the entry's stored videoUrl (played from our bucket), everything else goes to /api/download.

const PUB = 'https://xyz.supabase.co/storage/v1/object/public';

describe('isUploadedVideoUrl', () => {
  it('matches our post-videos public URLs only', () => {
    expect(isUploadedVideoUrl(`${PUB}/post-videos/u1/123_clip.mp4`)).toBe(true);
    expect(isUploadedVideoUrl('https://www.tiktok.com/@x/video/123')).toBe(false);
    expect(isUploadedVideoUrl(`${PUB}/post-images/u1/a.png`)).toBe(false);           // wrong bucket
    expect(isUploadedVideoUrl('https://xyz.supabase.co/storage/v1/object/sign/post-videos/u1/a.mp4')).toBe(false); // signed, not public
    expect(isUploadedVideoUrl('')).toBe(false);
  });

  it('rejects `_renders/` bakes — the cleanup cron sweeps them, so they must stay plain links', () => {
    expect(isUploadedVideoUrl(`${PUB}/post-videos/u1/_renders/reel_x.mp4`)).toBe(false);
    expect(isUploadedVideoUrl(`${PUB}/post-videos/u1/_renders/reel_x.mp4?download=1`)).toBe(false);
  });
});

describe('uploadedVideoDisplayName', () => {
  it('returns the stored filename without our timestamp prefix', () => {
    expect(uploadedVideoDisplayName(`${PUB}/post-videos/u1/1721400000000_my_clip.mp4`)).toBe('my_clip.mp4');
  });

  it('decodes percent-encoding and strips query/hash', () => {
    expect(uploadedVideoDisplayName(`${PUB}/post-videos/u1/1721400000000_My%20Clip.mp4?download=1#t`)).toBe('My Clip.mp4');
  });

  it('falls back for a bare/unparseable path', () => {
    expect(uploadedVideoDisplayName(`${PUB}/post-videos/u1/1721400000000_`)).toBe('uploaded video');
  });
});
