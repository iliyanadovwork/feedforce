'use client';

// Client-side background removal. Takes an HTMLImageElement | HTMLCanvasElement | Blob and
// returns a cut-out PNG Blob (subject on a transparent background), using transformers.js
// (@huggingface/transformers) with the MIT-licensed BiRefNet_lite ONNX model. The model + ONNX
// runtime are lazily fetched from the Hugging Face CDN on first use and cached by the browser.
// Runs on WebGPU when available, falling back to WASM/CPU.
//
// The library is dynamically imported (not a static top-level import) so its ~100 MB of runtime
// stays out of the initial bundle and only loads on first background-removal. The exported
// contract is unchanged from the previous @imgly implementation: callers await
// removeBackgroundBlob(input) and build an Image() from the returned transparent PNG Blob.

type TJS = typeof import('@huggingface/transformers');
type Segmenter = {
  model: Awaited<ReturnType<TJS['AutoModel']['from_pretrained']>>;
  processor: Awaited<ReturnType<TJS['AutoProcessor']['from_pretrained']>>;
  device: 'webgpu' | 'wasm';
};

// BiRefNet_lite (MIT) exported at a FIXED 512×512 input. We use the 512 export specifically
// because the 1024 export's activations exhaust the WASM heap (std::bad_alloc) on CPU and its
// graph rejects any other size; 512² is ~¼ the footprint and runs on WASM. Same weights/quality
// as 1024 BiRefNet_lite, just lower inference resolution (the matte is upscaled back to source).
const MODEL_ID = 'studioludens/birefnet-lite-512';
// fp16 (~94 MB) is the lightest build (no q8 export). Switch to 'fp32' only if fp16 shows
// numerical degradation on CPU.
const DTYPE: 'fp16' | 'fp32' = 'fp16';

let tjsPromise: Promise<TJS> | null = null;
const getTjs = (): Promise<TJS> => (tjsPromise ??= import('@huggingface/transformers'));

// Lazy module singleton: load model + processor exactly once, on the WASM/CPU backend.
// We deliberately do NOT use WebGPU: BiRefNet's shader needs 11 storage buffers per stage, but
// the WebGPU limit on most consumer GPUs is 8–10, so the model loads on WebGPU yet fails at
// OrtRun — and once a WebGPU session is created, transformers.js can't be switched to WASM in
// the same page session, so there's no reliable runtime fallback. WASM works everywhere.
let segmenterPromise: Promise<Segmenter> | null = null;
function loadSegmenter(): Promise<Segmenter> {
  if (segmenterPromise) return segmenterPromise;
  const promise = (async (): Promise<Segmenter> => {
    const { env, AutoModel, AutoProcessor } = await getTjs();
    env.allowLocalModels = false;          // always fetch from the HF CDN, then browser-cache
    const processor = await AutoProcessor.from_pretrained(MODEL_ID);   // its config already targets 512²
    const model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'wasm' });
    return { model, processor, device: 'wasm' };
  })();
  segmenterPromise = promise;
  // On failure, clear the cache so a later call can retry — but only if it's still THIS promise
  // (guards against a failed concurrent load nulling out a different, successful one).
  promise.catch(() => { if (segmenterPromise === promise) segmenterPromise = null; });
  return promise;
}

// Normalise any accepted input into a RawImage (transformers.js's native image type).
async function toRawImage(input: HTMLImageElement | HTMLCanvasElement | Blob) {
  const { RawImage } = await getTjs();
  if (input instanceof Blob) return RawImage.fromBlob(input);
  const w = input instanceof HTMLCanvasElement ? input.width : input.naturalWidth;
  const h = input instanceof HTMLCanvasElement ? input.height : input.naturalHeight;
  if (!w || !h) throw new Error('removeBackgroundBlob: source image has zero dimensions');
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  if (!tctx) throw new Error('removeBackgroundBlob: 2D context unavailable');
  tctx.drawImage(input, 0, 0);
  const blob = await new Promise<Blob>((res, rej) =>
    tmp.toBlob(b => (b ? res(b) : rej(new Error('canvas toBlob failed'))), 'image/png'));
  return RawImage.fromBlob(blob);
}

export async function removeBackgroundBlob(
  input: HTMLImageElement | HTMLCanvasElement | Blob,
): Promise<Blob> {
  const { RawImage } = await getTjs();
  const seg = await loadSegmenter();

  const image = await toRawImage(input);

  // Preprocess (resize to 512², rescale, ImageNet-normalize), run inference.
  const { pixel_values } = await seg.processor(image);
  const outputs = await seg.model({ input_image: pixel_values });

  // Output is the alpha matte as logits, shape [1, 1, 512, 512]. Named 'logits' on this model;
  // fall back to the first output tensor defensively. Apply sigmoid → 0..255 uint8 → resize to source.
  const out = (outputs as Record<string, unknown>).logits ?? Object.values(outputs as Record<string, unknown>)[0];
  if (!out) throw new Error('removeBackgroundBlob: model returned no output tensor');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matteTensor = (out as any)[0].sigmoid().mul(255).to('uint8');
  const matte = await RawImage.fromTensor(matteTensor).resize(image.width, image.height);
  const maskData = matte.data as Uint8Array | Uint8ClampedArray;

  // Composite: draw the source RGB, then write the matte into the alpha channel.
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('removeBackgroundBlob: 2D context unavailable');
  ctx.drawImage(image.toCanvas() as unknown as CanvasImageSource, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height);
  const data = pixels.data;
  const px = image.width * image.height;
  // The matte should be 1 byte/pixel; derive the stride defensively so a multi-channel
  // matte (or a length mismatch) reads the right alpha rather than leaving fringes opaque.
  const step = Math.max(1, Math.round(maskData.length / px));
  for (let i = 0; i < px; i++) data[4 * i + 3] = maskData[i * step] ?? 0;   // alpha = matte
  ctx.putImageData(pixels, 0, 0);

  return new Promise<Blob>((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('canvas toBlob (png) failed'))), 'image/png'));
}
