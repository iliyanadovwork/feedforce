// Browser-side video frame capture for the Content Sheet's AI caption extraction: load a video
// (same-origin /api/proxy stream, or the CORS-open storage bucket for uploads), seek to a couple of
// spread-out timestamps, and return downscaled JPEG data URLs. Two frames at different times let
// the vision model tell the fixed creator overlay apart from changing speech subtitles.

const MAX_SIDE = 720;          // longest output side — plenty for reading overlay text, cheap to send
const CAPTURE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Sampled luminance spread — a decoded video frame essentially never reads as one flat color,
// while an undecoded paint is solid black (or white). Stride keeps this O(hundreds) of pixels.
function frameLooksBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4 * 1009) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return max - min < 8;
}

function once(el: HTMLVideoElement, ok: string, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`${what} failed`)); };
    const cleanup = () => {
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(ok, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

/** Capture up to two frames (~1s and ~4s, clamped to the video's duration) as JPEG data URLs.
 *  Throws on load/seek/decode failure — callers treat frames as best-effort. */
export async function captureVideoFrames(src: string): Promise<string[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';   // proxy is same-origin; the storage bucket serves CORS-open

  try {
    const loaded = once(video, 'loadedmetadata', 'Video load');
    video.src = src;
    await withTimeout(loaded, CAPTURE_TIMEOUT_MS, 'Video load');

    // Some proxied streams report Infinity/NaN until fully buffered — fall back to the fixed marks.
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    const times = dur === Infinity
      ? [1, 4]
      : [Math.min(1, dur * 0.25), Math.min(4, Math.max(dur - 0.5, dur * 0.75))];
    // A very short clip collapses both marks to ~the same instant — one frame is enough then.
    const distinct = times[1] - times[0] > 0.3 ? times : [times[0]];

    const canvas = document.createElement('canvas');
    const frames: string[] = [];
    for (const t of distinct) {
      const seeked = once(video, 'seeked', 'Video seek');
      video.currentTime = t;
      await withTimeout(seeked, CAPTURE_TIMEOUT_MS, 'Video seek');
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) throw new Error('Video has no decodable frames');
      const k = Math.min(1, MAX_SIDE / Math.max(w, h));
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // A paused just-seeked video sometimes paints BEFORE the decoder delivers the frame — the
      // canvas gets solid black, and the vision model truthfully reads "no caption" off it. (The
      // original flow captured from a video already playing on screen, so it never hit this.)
      // Detect a flat frame and nudge the decode pipeline with a brief muted inline play.
      if (frameLooksBlank(ctx, canvas.width, canvas.height)) {
        try {
          await video.play();
          await new Promise(r => setTimeout(r, 150));
          video.pause();
        } catch { /* autoplay rejection — keep whatever the redraw gives */ }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      frames.push(canvas.toDataURL('image/jpeg', 0.8));   // throws if the source tainted the canvas
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();   // release the network/decoder resources immediately
  }
}
