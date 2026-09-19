// Phase 5 hardening — render a custom element's (untrusted) code on an OffscreenCanvas inside a Web Worker,
// so a heavy or misbehaving element can't block / crash the editor's main thread. The worker is built from
// an inline Blob (no bundler worker-file config), and the runtime falls back to the synchronous main-thread
// renderer when Worker / OffscreenCanvas / transferToImageBitmap aren't available (SSR, older browsers,
// worker error, or a slow render). Used by the live preview path; the synchronous renderer still backs the
// export path (which must draw into the shared canvas in one pass).

const WORKER_SRC = `
const cache = new Map();
function compile(code){ if(cache.has(code)) return cache.get(code); let fn=null; try{ fn=new Function('ctx','props','"use strict";\\n'+code);}catch(e){fn=null;} cache.set(code,fn); return fn; }
function drawErr(ctx,w,h){ ctx.save(); ctx.strokeStyle='rgba(248,113,113,0.9)'; ctx.setLineDash([6,4]); ctx.lineWidth=2; ctx.strokeRect(1,1,Math.max(0,w-2),Math.max(0,h-2)); ctx.setLineDash([]); ctx.fillStyle='rgba(248,113,113,0.9)'; ctx.font=Math.max(11,Math.round(h*0.08))+'px system-ui,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('\\u26A0 element error', w/2, h/2); ctx.restore(); }
self.onmessage = function(e){
  const d=e.data, p=d.props, w=Math.max(1,p.width|0), h=Math.max(1,p.height|0);
  let canvas, ctx;
  try { canvas=new OffscreenCanvas(w,h); ctx=canvas.getContext('2d'); } catch(err){ self.postMessage({id:d.id,error:'no-offscreen'}); return; }
  if(!ctx){ self.postMessage({id:d.id,error:'no-ctx'}); return; }
  const fn=compile(d.code);
  ctx.save();
  try { if(fn) fn(ctx,p); else drawErr(ctx,w,h); } catch(err){ drawErr(ctx,w,h); } finally { ctx.restore(); }
  let bmp; try { bmp=canvas.transferToImageBitmap(); } catch(err){ self.postMessage({id:d.id,error:'no-bitmap'}); return; }
  self.postMessage({id:d.id,bitmap:bmp},[bmp]);
};
`;

let worker: Worker | null | undefined;   // undefined = not tried yet; null = unavailable
let nextId = 1;
const pending = new Map<number, (b: ImageBitmap | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    const w = new Worker(url);
    w.onmessage = (e: MessageEvent) => {
      const { id, bitmap } = e.data as { id: number; bitmap?: ImageBitmap };
      const cb = pending.get(id);
      pending.delete(id);
      cb?.(bitmap ?? null);
    };
    w.onerror = () => { /* leave the request to time out → sync fallback */ };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

// Render to an ImageBitmap in the worker, or resolve null if the worker path is unavailable/slow (the
// caller then renders synchronously on the main thread). `props` must be structured-cloneable.
export function renderElementBitmap(code: string, props: unknown): Promise<ImageBitmap | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = nextId++;
    let done = false;
    pending.set(id, b => { done = true; resolve(b); });
    try { w.postMessage({ id, code, props }); }
    catch { pending.delete(id); resolve(null); return; }
    setTimeout(() => { if (!done) { pending.delete(id); resolve(null); } }, 4000);
  });
}
