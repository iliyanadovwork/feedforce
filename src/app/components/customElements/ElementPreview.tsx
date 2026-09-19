'use client';

import { useEffect, useRef } from 'react';
import { renderCustomElement, type ElementRenderTheme } from '@/lib/customElements/runtime';
import { renderElementBitmap } from '@/lib/customElements/workerRenderer';

// Draws a custom element's code into a canvas (native size, CSS-scaled to `displayW`) via the runtime.
// `animate` plays it like a real coded component (loops progress 0→1 with a hold, à la angelstyle2's
// animated chart) by rendering synchronously each frame; otherwise it renders one settled frame through
// the isolated worker (with a sync fallback) — used for static library thumbnails.
export function ElementPreview({ code, data, size, theme, displayW = 280, progress = 1, animate = false, className }: {
  code: string;
  data: unknown;
  size: { w: number; h: number };
  theme: ElementRenderTheme;
  displayW?: number;
  progress?: number;
  animate?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    if (animate) {
      // rAF loop: progress ramps 0→1 over DUR, holds at 1 for HOLD, then repeats. Sync per-frame render
      // (a worker round-trip per frame would stutter); fine for a small preview of the user's own code.
      const DUR = 1500, HOLD = 900, CYCLE = DUR + HOLD;
      let raf = 0;
      let start = 0;
      const loop = (t: number) => {
        if (!start) start = t;
        const p = Math.min(1, ((t - start) % CYCLE) / DUR);
        ctx.clearRect(0, 0, c.width, c.height);
        renderCustomElement(ctx, code, { width: size.w, height: size.h, progress: p, t: t - start, data, theme });
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }

    let cancelled = false;
    const props = { width: size.w, height: size.h, progress, t: 0, data, theme };
    void renderElementBitmap(code, props).then(bmp => {
      if (cancelled) { bmp?.close?.(); return; }
      ctx.clearRect(0, 0, c.width, c.height);
      if (bmp) { ctx.drawImage(bmp, 0, 0); bmp.close?.(); }
      else renderCustomElement(ctx, code, props);
    });
    return () => { cancelled = true; };
  }, [code, data, size.w, size.h, theme, progress, animate]);

  const dispH = Math.round(displayW * (size.h / Math.max(1, size.w)));
  return (
    <canvas
      ref={ref}
      width={size.w}
      height={size.h}
      style={{ width: displayW, height: dispH }}
      className={className ?? 'rounded-md ring-1 ring-line bg-surface-2'}
    />
  );
}
