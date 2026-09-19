import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression lock for the render-upload failure path (incident 2026-07-19): oversized HD renders hit
// the storage 400 and the old bare-null return collapsed every failure into a generic "Failed to
// upload the reel", indistinguishable from RLS or network errors. The typed result must (a) reject
// oversized blobs BEFORE dispatch with an actionable size message, and (b) pass the real storage
// error message through.

const storage = vi.hoisted(() => ({
  upload: vi.fn<() => Promise<{ error: { message: string } | null }>>(),
}));

vi.mock('./supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: storage.upload,
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  },
}));

import { uploadRenderBlob, MAX_UPLOAD_BYTES } from './renderUpload';

// A Blob stand-in with a controllable size (creating a real 50 MiB blob in tests is wasteful).
const blobOfSize = (size: number) => ({ size }) as unknown as Blob;

beforeEach(() => {
  storage.upload.mockReset();
  storage.upload.mockResolvedValue({ error: null });
});

describe('uploadRenderBlob', () => {
  it('uploads an in-limit blob and returns ok with url/bucket/path', async () => {
    const res = await uploadRenderBlob('u1', 'post-videos', blobOfSize(MAX_UPLOAD_BYTES), 'reel_1.mp4', 'video/mp4');
    expect(res).toEqual({ ok: true, url: 'https://cdn.test/u1/_renders/reel_1.mp4', bucket: 'post-videos', path: 'u1/_renders/reel_1.mp4' });
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized blob BEFORE dispatch with the size and the cap in the message', async () => {
    const res = await uploadRenderBlob('u1', 'post-videos', blobOfSize(MAX_UPLOAD_BYTES + 1024 * 1024), 'reel_1.mp4', 'video/mp4');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain('51.0 MB');       // the actual size, so the user knows how far over they are
      expect(res.message).toContain('50 MB upload limit');
    }
    expect(storage.upload).not.toHaveBeenCalled();   // never wastes the user's bandwidth on a doomed upload
  });

  it('passes the REAL storage error message through instead of collapsing to a generic failure', async () => {
    storage.upload.mockResolvedValue({ error: { message: 'new row violates row-level security policy' } });
    const res = await uploadRenderBlob('u1', 'post-videos', blobOfSize(1024), 'reel_1.mp4', 'video/mp4');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe('Upload failed: new row violates row-level security policy');
  });

  it('fails closed with a sign-in message when there is no user id', async () => {
    const res = await uploadRenderBlob('', 'post-videos', blobOfSize(1024), 'reel_1.mp4', 'video/mp4');
    expect(res.ok).toBe(false);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
