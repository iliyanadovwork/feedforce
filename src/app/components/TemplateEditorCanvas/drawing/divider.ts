import type { DividerStyleSettings, ShadowStyle } from '../../templateEditorTypes';
import { defaultDividerSettings } from '../../templateEditorTypes';

export function divHexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(3)})`;
}

export function drawWaveSegment(
  ctx: CanvasRenderingContext2D,
  x1: number, x2: number, cy: number,
  amp: number, lineWeight: number, color: string,
) {
  const len = x2 - x1;
  if (len <= 2) return;
  const numCycles = Math.max(1, Math.round(len / 70));
  const seg = len / numCycles;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWeight;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, cy);
  for (let i = 0; i < numCycles; i++) {
    const sx = x1 + i * seg;
    ctx.bezierCurveTo(sx + seg * 0.25, cy - amp, sx + seg * 0.75, cy + amp, sx + seg, cy);
  }
  ctx.stroke();
  ctx.restore();
}

export function applyShadow(ctx: CanvasRenderingContext2D, shadow?: ShadowStyle | null) {
  if (!shadow?.enabled) return;
  const h = shadow.color.replace('#', '');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  ctx.shadowColor   = `rgba(${r},${g},${b},${(shadow.opacity/100).toFixed(3)})`;
  ctx.shadowBlur    = shadow.blur;
  ctx.shadowOffsetX = shadow.offsetX;
  ctx.shadowOffsetY = shadow.offsetY;
}

export function clearShadow(ctx: CanvasRenderingContext2D) {
  ctx.shadowColor   = 'transparent';
  ctx.shadowBlur    = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

export function drawDividerOnCanvas(
  ctx: CanvasRenderingContext2D,
  divId: string,
  x: number, y: number, w: number, h: number,
  contentW?: number | null,
  contentCY?: number | null,
  ds?: Partial<DividerStyleSettings> | null,
  pulseAlpha?: number,
) {
  const S: DividerStyleSettings = { ...defaultDividerSettings(divId), ...(ds ?? {}) };
  const C1 = divHexToRgba(S.lineColor, S.lineOpacity);
  const C2 = divHexToRgba(S.lineColor, Math.round(S.lineOpacity * 0.636));
  const hasCW = contentW != null;
  // contentCY overrides center when explicitly provided (content present OR positional alignment from slot position)
  const cy = contentCY ?? (y + h / 2);
  ctx.save();
  switch (divId) {
    case 'solid':
      ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke(); break;
    case 'thick':
      ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke(); break;
    case 'dashed':
      ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight; ctx.setLineDash([S.dashLen, S.dashGap]);
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.setLineDash([]); break;
    case 'dotted':
      ctx.strokeStyle = C1; ctx.lineWidth = S.dotSize; ctx.lineCap = 'round';
      ctx.setLineDash([Math.round(S.dotSize * 0.5), S.dotSpacing]);
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.setLineDash([]); break;
    case 'double':
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy - S.doubleSpacing); ctx.lineTo(x + w, cy - S.doubleSpacing); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, cy + S.doubleSpacing); ctx.lineTo(x + w, cy + S.doubleSpacing); ctx.stroke(); break;
    case 'triple':
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy - S.tripleSpacing); ctx.lineTo(x + w, cy - S.tripleSpacing); ctx.stroke();
      ctx.strokeStyle = C1; ctx.lineWidth = S.centerWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy + S.tripleSpacing); ctx.lineTo(x + w, cy + S.tripleSpacing); ctx.stroke(); break;
    case 'dot-center': {
      const mid = x + w / 2;
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(mid - S.dotRadius - S.dotGap, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mid + S.dotRadius + S.dotGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.fillStyle = C1; ctx.beginPath(); ctx.arc(mid, cy, S.dotRadius, 0, Math.PI * 2); ctx.fill(); break;
    }
    case 'fade': {
      const fs = S.fadeSpread / 100;
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, 'transparent'); g.addColorStop(Math.max(0.001, fs), C1);
      g.addColorStop(Math.min(0.999, 1 - fs), C1); g.addColorStop(1, 'transparent');
      ctx.strokeStyle = g; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke(); break;
    }
    case 'fade-left': {
      const solidEnd = 1 - S.fadeSpread / 100;
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, C1); g.addColorStop(solidEnd, C1); g.addColorStop(1, 'transparent');
      ctx.strokeStyle = g; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke(); break;
    }
    case 'double-fade': {
      const fs = S.fadeSpread / 100;
      const g1 = ctx.createLinearGradient(x, 0, x + w, 0);
      g1.addColorStop(0, 'transparent'); g1.addColorStop(Math.max(0.001, fs), C2);
      g1.addColorStop(Math.min(0.999, 1 - fs), C2); g1.addColorStop(1, 'transparent');
      ctx.strokeStyle = g1; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy - S.doubleSpacing); ctx.lineTo(x + w, cy - S.doubleSpacing); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, cy + S.doubleSpacing); ctx.lineTo(x + w, cy + S.doubleSpacing); ctx.stroke(); break;
    }
    case 'logo-center': case 'logo-center-fade': {
      const lw = 120, lh = 56, mid = x + w / 2;
      const ew = hasCW ? contentW! : lw;
      const fs = S.fadeSpread / 100;
      const g = divId === 'logo-center-fade' ? ctx.createLinearGradient(x, 0, x + w, 0) : null;
      if (g) { g.addColorStop(0, 'transparent'); g.addColorStop(Math.max(0.001, fs), C2); }
      ctx.strokeStyle = g ?? C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(mid - ew / 2 - S.contentGap, cy); ctx.stroke();
      const g2 = divId === 'logo-center-fade' ? ctx.createLinearGradient(x, 0, x + w, 0) : null;
      if (g2) { g2.addColorStop(Math.min(0.999, 1 - fs), C2); g2.addColorStop(1, 'transparent'); }
      ctx.strokeStyle = g2 ?? C2;
      ctx.beginPath(); ctx.moveTo(mid + ew / 2 + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      if (!hasCW) { ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`; ctx.beginPath(); ctx.roundRect(mid - lw / 2, cy - lh / 2, lw, lh, 8); ctx.fill(); }
      break;
    }
    case 'logo-left': case 'logo-left-fade': {
      const lw = 120, lh = 56;
      const ew = hasCW ? contentW! : lw;
      const solidEnd = 1 - S.fadeSpread / 100;
      const g = divId === 'logo-left-fade' ? ctx.createLinearGradient(x, 0, x + w, 0) : null;
      if (g) { g.addColorStop(0, C2); g.addColorStop(solidEnd, C2); g.addColorStop(1, 'transparent'); }
      ctx.strokeStyle = g ?? C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x + ew + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      if (!hasCW) { ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`; ctx.beginPath(); ctx.roundRect(x, cy - lh / 2, lw, lh, 8); ctx.fill(); }
      break;
    }
    case 'logo-right': {
      const lw = 120, lh = 56;
      const ew = hasCW ? contentW! : lw;
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w - ew - S.contentGap, cy); ctx.stroke();
      if (!hasCW) { ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`; ctx.beginPath(); ctx.roundRect(x + w - lw, cy - lh / 2, lw, lh, 8); ctx.fill(); }
      break;
    }
    case 'taper': case 'thick-taper': {
      const th = h * (S.taperHeight / 100);
      ctx.fillStyle = C1; ctx.beginPath();
      ctx.moveTo(x, cy); ctx.lineTo(x + w / 2, cy - th);
      ctx.lineTo(x + w, cy); ctx.lineTo(x + w / 2, cy + th);
      ctx.closePath(); ctx.fill(); break;
    }
    case 'short-center': {
      const halfLen = w * (S.shortLength / 100) / 2;
      ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x + w / 2 - halfLen, cy); ctx.lineTo(x + w / 2 + halfLen, cy); ctx.stroke(); break;
    }
    case 'wave': {
      ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight; ctx.beginPath();
      const seg = w / 4;
      const amp = h * (S.waveAmplitude / 100);
      ctx.moveTo(x, cy);
      for (let s = 0; s < 4; s++) {
        const sx = x + s * seg;
        ctx.bezierCurveTo(sx + seg * 0.25, cy - amp, sx + seg * 0.75, cy + amp, sx + seg, cy);
      }
      ctx.stroke(); break;
    }
    case 'brackets': {
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x + S.bracketMargin + S.bracketWidth, cy); ctx.lineTo(x + w - S.bracketMargin - S.bracketWidth, cy); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + S.bracketMargin + S.bracketWidth, cy - h * 0.3); ctx.lineTo(x + S.bracketMargin, cy - h * 0.3);
      ctx.lineTo(x + S.bracketMargin, cy + h * 0.3); ctx.lineTo(x + S.bracketMargin + S.bracketWidth, cy + h * 0.3); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + w - S.bracketMargin - S.bracketWidth, cy - h * 0.3); ctx.lineTo(x + w - S.bracketMargin, cy - h * 0.3);
      ctx.lineTo(x + w - S.bracketMargin, cy + h * 0.3); ctx.lineTo(x + w - S.bracketMargin - S.bracketWidth, cy + h * 0.3); ctx.stroke(); break;
    }
    case 'tag-center': case 'tag-center-fade': case 'tag-double': case 'tag-short': {
      const tw = 140, th = 48, mid = x + w / 2;
      const ew = hasCW ? contentW! : tw;
      const fade = divId === 'tag-center-fade';
      if (divId === 'tag-double') {
        ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
        [-S.doubleSpacing, S.doubleSpacing].forEach(dy => {
          ctx.beginPath(); ctx.moveTo(x, cy + dy); ctx.lineTo(mid - ew / 2 - S.contentGap, cy + dy); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(mid + ew / 2 + S.contentGap, cy + dy); ctx.lineTo(x + w, cy + dy); ctx.stroke();
        });
      } else if (divId === 'tag-short') {
        const sw = 80;
        ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight;
        ctx.beginPath(); ctx.moveTo(mid - ew / 2 - sw - S.contentGap, cy); ctx.lineTo(mid - ew / 2 - S.contentGap, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mid + ew / 2 + S.contentGap, cy); ctx.lineTo(mid + ew / 2 + sw + S.contentGap, cy); ctx.stroke();
      } else {
        const fs = S.fadeSpread / 100;
        const gl = fade ? ctx.createLinearGradient(x, 0, x + w, 0) : null;
        if (gl) { gl.addColorStop(0, 'transparent'); gl.addColorStop(Math.max(0.001, fs), C2); }
        ctx.strokeStyle = gl ?? C2; ctx.lineWidth = S.lineWeight;
        ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(mid - ew / 2 - S.contentGap, cy); ctx.stroke();
        const gr = fade ? ctx.createLinearGradient(x, 0, x + w, 0) : null;
        if (gr) { gr.addColorStop(Math.min(0.999, 1 - fs), C2); gr.addColorStop(1, 'transparent'); }
        ctx.strokeStyle = gr ?? C2;
        ctx.beginPath(); ctx.moveTo(mid + ew / 2 + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      }
      if (!hasCW) {
        ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
        ctx.beginPath(); ctx.roundRect(mid - tw / 2, cy - th / 2, tw, th, 6); ctx.fill();
        ctx.fillStyle = C1;
        ctx.beginPath(); ctx.roundRect(mid - 24, cy - 6, 48, 12, 4); ctx.fill();
      }
      break;
    }
    case 'tag-left': case 'tag-left-fade': {
      const tw = 140, th = 48;
      const ew = hasCW ? contentW! : tw;
      const fade = divId === 'tag-left-fade';
      const solidEnd = 1 - S.fadeSpread / 100;
      const gl = fade ? ctx.createLinearGradient(x, 0, x + w, 0) : null;
      if (gl) { gl.addColorStop(0, C2); gl.addColorStop(solidEnd, C2); gl.addColorStop(1, 'transparent'); }
      ctx.strokeStyle = gl ?? C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x + ew + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      if (!hasCW) {
        ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
        ctx.beginPath(); ctx.roundRect(x, cy - th / 2, tw, th, 6); ctx.fill();
        ctx.fillStyle = C1;
        ctx.beginPath(); ctx.roundRect(x + tw / 2 - 24, cy - 6, 48, 12, 4); ctx.fill();
      }
      break;
    }
    case 'tag-right': {
      const tw = 140, th = 48;
      const ew = hasCW ? contentW! : tw;
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w - ew - S.contentGap, cy); ctx.stroke();
      if (!hasCW) {
        ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
        ctx.beginPath(); ctx.roundRect(x + w - tw, cy - th / 2, tw, th, 6); ctx.fill();
        ctx.fillStyle = C1;
        ctx.beginPath(); ctx.roundRect(x + w - tw / 2 - 24, cy - 6, 48, 12, 4); ctx.fill();
      }
      break;
    }
    case 'tag-logo': {
      const lw = 100, tw = 110, th = 48, lh = 48, gap = 20, mid = x + w / 2;
      const ew = hasCW ? contentW! : (lw + tw + gap);
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(mid - ew / 2 - S.contentGap, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mid + ew / 2 + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      if (!hasCW) {
        ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
        ctx.beginPath(); ctx.roundRect(mid - ew / 2, cy - lh / 2, lw, lh, 8); ctx.fill();
        ctx.beginPath(); ctx.roundRect(mid - ew / 2 + lw + gap, cy - th / 2, tw, th, 6); ctx.fill();
        ctx.fillStyle = C1;
        ctx.beginPath(); ctx.roundRect(mid - ew / 2 + lw + gap + tw / 2 - 22, cy - 6, 44, 12, 4); ctx.fill();
      }
      break;
    }
    case 'wave-logo-center': case 'wave-logo-left': case 'wave-logo-right':
    case 'wave-tag-center':  case 'wave-tag-left':  case 'wave-tag-right': {
      const isLogo = divId.includes('logo');
      const ew0 = isLogo ? 120 : 140;
      const eh  = isLogo ? 56  : 48;
      const ew  = hasCW ? contentW! : ew0;
      const amp = h * (S.waveAmplitude / 100);
      const pos = divId.endsWith('-center') ? 'center' : divId.endsWith('-left') ? 'left' : 'right';
      if (pos === 'center') {
        const mid = x + w / 2;
        drawWaveSegment(ctx, x, mid - ew / 2 - S.contentGap, cy, amp, S.lineWeight, C1);
        drawWaveSegment(ctx, mid + ew / 2 + S.contentGap, x + w, cy, amp, S.lineWeight, C1);
        if (!hasCW) {
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(mid - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      } else if (pos === 'left') {
        drawWaveSegment(ctx, x + ew + S.contentGap, x + w, cy, amp, S.lineWeight, C1);
        if (!hasCW) {
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(x, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(x, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(x + ew0 / 2 - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      } else {
        drawWaveSegment(ctx, x, x + w - ew - S.contentGap, cy, amp, S.lineWeight, C1);
        if (!hasCW) {
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(x + w - ew0, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(x + w - ew0, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(x + w - ew0 / 2 - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      }
      break;
    }
    case 'taper-logo-center': case 'taper-logo-left': case 'taper-logo-right':
    case 'taper-tag-center':  case 'taper-tag-left':  case 'taper-tag-right': {
      const isLogo = divId.includes('logo');
      const ew0 = isLogo ? 120 : 140;
      const eh  = isLogo ? 56  : 48;
      const ew  = hasCW ? contentW! : ew0;
      const th  = h * (S.taperHeight / 100);
      const pos = divId.endsWith('-center') ? 'center' : divId.endsWith('-left') ? 'left' : 'right';
      ctx.fillStyle = C1;
      if (pos === 'center') {
        const mid = x + w / 2;
        const lx = mid - ew / 2 - S.contentGap;
        const rx = mid + ew / 2 + S.contentGap;
        // Left inward-pointing triangle
        ctx.beginPath(); ctx.moveTo(x, cy - th); ctx.lineTo(lx, cy); ctx.lineTo(x, cy + th); ctx.closePath(); ctx.fill();
        // Right inward-pointing triangle
        ctx.beginPath(); ctx.moveTo(x + w, cy - th); ctx.lineTo(rx, cy); ctx.lineTo(x + w, cy + th); ctx.closePath(); ctx.fill();
        if (!hasCW) {
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(mid - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      } else if (pos === 'left') {
        // Right-pointing triangle from element edge to right side
        const startX = x + ew + S.contentGap;
        ctx.beginPath(); ctx.moveTo(startX, cy - th); ctx.lineTo(x + w, cy); ctx.lineTo(startX, cy + th); ctx.closePath(); ctx.fill();
        if (!hasCW) {
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(x, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(x, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(x + ew0 / 2 - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      } else {
        // Left-pointing triangle from left side to element edge
        const endX = x + w - ew - S.contentGap;
        ctx.beginPath(); ctx.moveTo(endX, cy - th); ctx.lineTo(x, cy); ctx.lineTo(endX, cy + th); ctx.closePath(); ctx.fill();
        if (!hasCW) {
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(x + w - ew0, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(x + w - ew0, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(x + w - ew0 / 2 - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      }
      break;
    }
    case 'taper-logo-center-out': case 'taper-tag-center-out': {
      const isLogo = divId === 'taper-logo-center-out';
      const ew0 = isLogo ? 120 : 140;
      const eh  = isLogo ? 56  : 48;
      const ew  = hasCW ? contentW! : ew0;
      const th  = h * (S.taperHeight / 100);
      const mid = x + w / 2;
      const lx = mid - ew / 2 - S.contentGap;
      const rx = mid + ew / 2 + S.contentGap;
      ctx.fillStyle = C1;
      // Left outward-pointing triangle: wide at element edge, tip at left outer edge
      ctx.beginPath(); ctx.moveTo(lx, cy - th); ctx.lineTo(x, cy); ctx.lineTo(lx, cy + th); ctx.closePath(); ctx.fill();
      // Right outward-pointing triangle: wide at element edge, tip at right outer edge
      ctx.beginPath(); ctx.moveTo(rx, cy - th); ctx.lineTo(x + w, cy); ctx.lineTo(rx, cy + th); ctx.closePath(); ctx.fill();
      if (!hasCW) {
        ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
        if (isLogo) { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
        else { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C1; ctx.beginPath(); ctx.roundRect(mid - 24, cy - 6, 48, 12, 4); ctx.fill(); }
      }
      break;
    }
    case 'dashed-logo-center': case 'dashed-logo-left': case 'dashed-logo-right':
    case 'dashed-tag-center':  case 'dashed-tag-left':  case 'dashed-tag-right': {
      const isLogo = divId.includes('logo');
      const ew0 = isLogo ? 120 : 140;
      const eh  = isLogo ? 56  : 48;
      const ew  = hasCW ? contentW! : ew0;
      const pos = divId.endsWith('-center') ? 'center' : divId.endsWith('-left') ? 'left' : 'right';
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.setLineDash([S.dashLen, S.dashGap]);
      if (pos === 'center') {
        const mid = x + w / 2;
        ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(mid - ew / 2 - S.contentGap, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mid + ew / 2 + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
        if (!hasCW) {
          ctx.setLineDash([]);
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(mid - ew0 / 2, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C2; ctx.beginPath(); ctx.roundRect(mid - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      } else if (pos === 'left') {
        ctx.beginPath(); ctx.moveTo(x + ew + S.contentGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
        if (!hasCW) {
          ctx.setLineDash([]);
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(x, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(x, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C2; ctx.beginPath(); ctx.roundRect(x + ew0 / 2 - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      } else {
        ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w - ew - S.contentGap, cy); ctx.stroke();
        if (!hasCW) {
          ctx.setLineDash([]);
          ctx.fillStyle = `rgba(255,255,255,${(pulseAlpha ?? 0.12).toFixed(3)})`;
          if (isLogo) { ctx.beginPath(); ctx.roundRect(x + w - ew0, cy - eh / 2, ew0, eh, 8); ctx.fill(); }
          else { ctx.beginPath(); ctx.roundRect(x + w - ew0, cy - eh / 2, ew0, eh, 6); ctx.fill(); ctx.fillStyle = C2; ctx.beginPath(); ctx.roundRect(x + w - ew0 / 2 - 24, cy - 6, 48, 12, 4); ctx.fill(); }
        }
      }
      ctx.setLineDash([]);
      break;
    }
    case 'dashed-fade': case 'taper-dashed': {
      const fs = S.fadeSpread / 100;
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, 'transparent'); g.addColorStop(Math.max(0.001, fs), C1);
      g.addColorStop(Math.min(0.999, 1 - fs), C1); g.addColorStop(1, 'transparent');
      ctx.strokeStyle = g; ctx.lineWidth = S.lineWeight;
      ctx.setLineDash([S.dashLen, S.dashGap]);
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.setLineDash([]); break;
    }
    case 'dots-row': {
      const mid = x + w / 2;
      const numDots = 6;
      const totalW = (numDots - 1) * S.dotSpacing;
      const startX = mid - totalW / 2;
      const opacities = [0.3, 0.6, 1, 1, 0.6, 0.3];
      for (let i = 0; i < numDots; i++) {
        ctx.globalAlpha = opacities[i] * (S.lineOpacity / 100);
        ctx.fillStyle = S.lineColor;
        ctx.beginPath();
        ctx.arc(startX + i * S.dotSpacing, cy, S.dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'diamond-center': {
      const mid = x + w / 2;
      ctx.strokeStyle = C2; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(mid - S.dotRadius - S.dotGap, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mid + S.dotRadius + S.dotGap, cy); ctx.lineTo(x + w, cy); ctx.stroke();
      ctx.fillStyle = C1;
      ctx.beginPath();
      ctx.moveTo(mid, cy - S.dotRadius);
      ctx.lineTo(mid + S.dotRadius, cy);
      ctx.lineTo(mid, cy + S.dotRadius);
      ctx.lineTo(mid - S.dotRadius, cy);
      ctx.closePath(); ctx.fill();
      break;
    }
    default:
      ctx.strokeStyle = C1; ctx.lineWidth = S.lineWeight;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke();
  }
  ctx.restore();
}

export function getSubZoneCanvasBounds(
  divId: string, x: number, y: number, w: number, h: number,
): { x: number; y: number; w: number; h: number } | null {
  const cy = y + h / 2;
  switch (divId) {
    case 'logo-center': case 'logo-center-fade': {
      const lw = 120, lh = 56, mid = x + w / 2;
      return { x: mid - lw / 2, y: cy - lh / 2, w: lw, h: lh };
    }
    case 'logo-left': case 'logo-left-fade': {
      const lw = 120, lh = 56;
      return { x, y: cy - lh / 2, w: lw, h: lh };
    }
    case 'logo-right': {
      const lw = 120, lh = 56;
      return { x: x + w - lw, y: cy - lh / 2, w: lw, h: lh };
    }
    case 'tag-center': case 'tag-center-fade': case 'tag-double': case 'tag-short': {
      const tw = 140, th = 48, mid = x + w / 2;
      return { x: mid - tw / 2, y: cy - th / 2, w: tw, h: th };
    }
    case 'tag-left': case 'tag-left-fade': {
      const tw = 140, th = 48;
      return { x, y: cy - th / 2, w: tw, h: th };
    }
    case 'tag-right': {
      const tw = 140, th = 48;
      return { x: x + w - tw, y: cy - th / 2, w: tw, h: th };
    }
    case 'tag-logo': {
      const lw = 100, tw = 110, gap = 20, lh = 48;
      const totalW = lw + tw + gap, mid = x + w / 2;
      return { x: mid - totalW / 2, y: cy - lh / 2, w: totalW, h: lh };
    }
    case 'wave-logo-center': case 'taper-logo-center': case 'taper-logo-center-out': case 'dashed-logo-center': {
      const lw = 120, lh = 56, mid = x + w / 2;
      return { x: mid - lw / 2, y: cy - lh / 2, w: lw, h: lh };
    }
    case 'wave-logo-left': case 'taper-logo-left': case 'dashed-logo-left': {
      const lw = 120, lh = 56;
      return { x, y: cy - lh / 2, w: lw, h: lh };
    }
    case 'wave-logo-right': case 'taper-logo-right': case 'dashed-logo-right': {
      const lw = 120, lh = 56;
      return { x: x + w - lw, y: cy - lh / 2, w: lw, h: lh };
    }
    case 'wave-tag-center': case 'taper-tag-center': case 'taper-tag-center-out': case 'dashed-tag-center': {
      const tw = 140, th = 48, mid = x + w / 2;
      return { x: mid - tw / 2, y: cy - th / 2, w: tw, h: th };
    }
    case 'wave-tag-left': case 'taper-tag-left': case 'dashed-tag-left': {
      const tw = 140, th = 48;
      return { x, y: cy - th / 2, w: tw, h: th };
    }
    case 'wave-tag-right': case 'taper-tag-right': case 'dashed-tag-right': {
      const tw = 140, th = 48;
      return { x: x + w - tw, y: cy - th / 2, w: tw, h: th };
    }
    default: return null;
  }
}
