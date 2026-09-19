'use client';

// Canvas "sparkle" mascot used as the reasoning icon (replaces the lucide BrainIcon). Two states, both
// animated: IDLE (a resting circle with eyes that blink + glance around) and ACTIVE/"thinking" (morphs into
// a pulsing 4-point star, eyes fade out). Ported from a standalone canvas sketch. Colour follows the
// element's currentColor (so it inherits the trigger's text-fg-3 → hover:text-fg like the old icon), and it
// honours prefers-reduced-motion by drawing a single static frame.
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type SparkleProps = {
  /** true = "thinking"/streaming (pulses into a star, eyes fade); false = idle (blinking, glancing eyes). */
  active?: boolean;
  /** Rendered size in CSS px. Defaults to 18 (a touch larger than a 16px icon so the eyes read). */
  size?: number;
  /** Override the stroke/fill colour. Defaults to the inherited currentColor. */
  color?: string;
  /** Outline stroke width in px. Defaults to a size-proportional value (~size/9). */
  strokeWidth?: number;
  className?: string;
};

const A = 0.3;            // star-point depth
const SPEED = 2.5;        // pulse speed
const BASE_PERIOD = 3.0;
const EASE = 6;           // how quickly it opens / settles (1/sec)
const SEGMENTS = 160;     // outline resolution (small icon → fewer segments is plenty)

export function Sparkle({ active = false, size = 18, color, strokeWidth, className }: SparkleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  // eslint-disable-next-line react-hooks/refs -- intended "latest ref" pattern (keep a ref pointing at the newest prop); the rule has known false positives for this (react/react#34775)
  activeRef.current = active;

  // Track devicePixelRatio so the canvas re-renders at full sharpness after a zoom, or a move to a screen
  // with a different pixel density. A `(resolution: Ndppx)` media query matches ONLY at the current DPR;
  // when it stops matching, DPR changed — re-read it and re-arm the query for the new value.
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      const next = window.devicePixelRatio || 1;
      setDpr(next);
      mql?.removeEventListener('change', onChange);
      mql = window.matchMedia(`(resolution: ${next}dppx)`);
      mql.addEventListener('change', onChange);
    };
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mql.addEventListener('change', onChange);
    return () => mql?.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // A canvas is raster (unlike the old SVG icon), so it must render at the display's TRUE physical-pixel
    // resolution or it looks soft next to the vector text. Use the tracked (live) devicePixelRatio — NOT
    // capped, since a capped DPR under a zoomed/HiDPI screen upscales and blurs — and supersample the tiny
    // icon 2× so the 1px stroke stays crisp. Even at 2×DPR that's only ~72px of backing — free per frame.
    const DPR = dpr * 2;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.width = Math.round(size * DPR);
    canvas.height = Math.round(size * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const LINE_WIDTH = strokeWidth ?? Math.max(1.25, size / 9);
    const period = BASE_PERIOD / SPEED;
    const omega = (2 * Math.PI) / period;
    const strokeColor = () => color || getComputedStyle(canvas).color || '#71717a';
    const restRadius = () => (size / 2 - LINE_WIDTH / 2 - 1) / (1 + A);

    const drawShape = (m: number) => {
      const c = size / 2;
      const R = restRadius();
      ctx.beginPath();
      for (let i = 0; i <= SEGMENTS; i++) {
        const th = (i / SEGMENTS) * Math.PI * 2;                 // r = R(1 + m·cos4θ): m=0 circle, else 4-star
        const rad = R * (1 + m * Math.cos(4 * th));
        const x = c + rad * Math.cos(th);
        const y = c + rad * Math.sin(th);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.lineWidth = LINE_WIDTH;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = strokeColor();
      ctx.stroke();
    };

    const drawEyes = (open: number, squash: number, gx: number, gy: number) => {
      if (open <= 0.01) return;
      const c = size / 2;
      const R = restRadius();
      const eyeDX = 0.28 * R;
      const rx = 0.105 * R * open;
      const ry = Math.max(0.4, 0.15 * R * squash * open);
      const eyeY = c - 0.05 * R + gy;
      ctx.save();
      ctx.globalAlpha = open;
      ctx.fillStyle = strokeColor();
      ctx.beginPath();
      ctx.ellipse(c - eyeDX + gx, eyeY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(c + eyeDX + gx, eyeY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    // Reduced motion: draw one static frame (open-eyed circle at rest, or a fixed star when active) and stop.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      ctx.clearRect(0, 0, size, size);
      if (activeRef.current) drawShape(A * 0.6);
      else { drawShape(0); drawEyes(1, 1, 0, 0); }
      return;
    }

    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    let amt = 0;                // eased open amount (0 = circle, 1 = pulsing star)
    let phase = 0;
    let prevActive = activeRef.current;
    let tNow = 0;
    let nextBlink = rand(1, 3);
    let blinkT = -1;
    const BLINK_DUR = 0.16;
    let gx = 0, gxTarget = 0, gy = 0, gyTarget = 0;
    let nextGlance = rand(1.4, 3.2);
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      tNow += dt;

      const nowActive = activeRef.current;
      if (nowActive && !prevActive && amt < 0.02) phase = 0;   // start the pulse from the top on a fresh play
      prevActive = nowActive;

      amt += ((nowActive ? 1 : 0) - amt) * (1 - Math.exp(-dt * EASE));
      if (nowActive) phase += dt * omega;
      const m = A * amt * Math.sin(phase);
      const eyeOpen = 1 - amt;

      if (blinkT < 0 && tNow > nextBlink) {
        blinkT = 0;
        nextBlink = tNow + rand(2.2, 5.2);
        if (Math.random() < 0.18) nextBlink = tNow + 0.28;      // occasional double blink
      }
      if (blinkT >= 0) { blinkT += dt / BLINK_DUR; if (blinkT >= 1) blinkT = -1; }
      const squash = blinkT >= 0 ? 1 - Math.sin(blinkT * Math.PI) : 1;

      const R = restRadius();
      if (tNow > nextGlance) {
        if (Math.random() < 0.45) { gxTarget = 0; gyTarget = 0; }
        else { gxTarget = rand(-1, 1) * 0.2 * R; gyTarget = rand(-1, 1) * 0.02 * R; }
        nextGlance = tNow + rand(1.4, 3.4);
      }
      gx += (gxTarget - gx) * (1 - Math.exp(-dt * 9));
      gy += (gyTarget - gy) * (1 - Math.exp(-dt * 9));
      const bob = Math.sin(tNow * 1.6) * 0.012 * R;

      ctx.clearRect(0, 0, size, size);
      drawShape(m);
      drawEyes(eyeOpen, squash, gx, gy + bob);
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, color, strokeWidth, dpr]);

  return <canvas ref={canvasRef} className={cn('inline-block shrink-0', className)} aria-hidden />;
}
