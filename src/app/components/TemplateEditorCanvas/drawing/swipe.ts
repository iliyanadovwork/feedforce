import type { SwipeStyle } from '../../templateEditorTypes';

export function drawSwipeArrow(
  ctx: CanvasRenderingContext2D,
  style: SwipeStyle,
  dir: number,
  cx: number, cy: number,
  arrowLen: number,
  headSize: number,
) {
  const lw = style.arrowWeight ?? 2;
  ctx.strokeStyle = style.arrowColor;
  ctx.fillStyle   = style.arrowColor;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  const tipX  = cx + dir * arrowLen / 2;
  const tailX = cx - dir * arrowLen / 2;
  const hl    = headSize * 0.9;

  switch (style.arrowType) {
    case 'line':
    case 'curved': {
      if (style.arrowType === 'line') {
        ctx.beginPath();
        ctx.moveTo(tailX, cy);
        ctx.lineTo(tipX - dir * hl * 0.5, cy);
        ctx.stroke();
      } else {
        const r = arrowLen * 0.55;
        ctx.beginPath();
        ctx.arc(cx, cy + r, r, -Math.PI / 2 - dir * 0.6, -Math.PI / 2 + dir * 0.6);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(tipX - dir * hl, cy - headSize);
      ctx.lineTo(tipX, cy);
      ctx.lineTo(tipX - dir * hl, cy + headSize);
      ctx.stroke();
      break;
    }
    case 'triangle': {
      if (arrowLen > hl) {
        ctx.beginPath();
        ctx.moveTo(tailX, cy);
        ctx.lineTo(tipX - dir * hl, cy);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(tipX, cy);
      ctx.lineTo(tipX - dir * hl, cy - headSize);
      ctx.lineTo(tipX - dir * hl, cy + headSize);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'chevron': {
      ctx.beginPath();
      ctx.moveTo(tipX - dir * hl, cy - headSize);
      ctx.lineTo(tipX, cy);
      ctx.lineTo(tipX - dir * hl, cy + headSize);
      ctx.stroke();
      break;
    }
    case 'double-chevron': {
      const off = hl * 0.7;
      ctx.beginPath();
      ctx.moveTo(tipX - dir * hl - dir * off, cy - headSize);
      ctx.lineTo(tipX - dir * off, cy);
      ctx.lineTo(tipX - dir * hl - dir * off, cy + headSize);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tipX - dir * hl, cy - headSize);
      ctx.lineTo(tipX, cy);
      ctx.lineTo(tipX - dir * hl, cy + headSize);
      ctx.stroke();
      break;
    }
  }
}

export function drawSwipeOnCanvas(
  ctx: CanvasRenderingContext2D,
  slotX: number, slotY: number, slotW: number, slotH: number,
  ha: 'left' | 'center' | 'right',
  va: 'top' | 'center' | 'bottom',
  style: SwipeStyle,
  fontCss: string,
) {
  const alpha = (style.opacity ?? 100) / 100;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;

  const dir = style.direction === 'right' ? 1 : -1;
  const rawText = style.text ?? '';
  const text = style.allCaps ? rawText.toUpperCase() : rawText;
  const fs = style.fontSize;
  const lsPx = style.letterSpacing ?? 0;
  const arrowLen = style.arrowType !== 'chevron' && style.arrowType !== 'double-chevron'
    ? (style.arrowLength ?? 60) : 0;
  const headSize = style.arrowHeadSize ?? 10;
  const gap = style.gap ?? 12;
  const layout = style.layout;
  const showText  = layout !== 'arrow-only'  && text.length > 0;
  const showArrow = layout !== 'text-only';

  ctx.font = `${style.fontWeight} ${fs}px ${fontCss}`;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${lsPx}px`;
  const textW = showText ? ctx.measureText(text).width : 0;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';

  const arrowTotalW = showArrow ? arrowLen + headSize * 1.2 : 0;
  let totalW = 0, totalH = 0;

  if (layout === 'stacked') {
    totalW = Math.max(showText ? textW : 0, arrowTotalW);
    totalH = (showText ? fs : 0) + (showText && showArrow ? gap : 0) + (showArrow ? headSize * 2 : 0);
  } else if (layout === 'arrow-only') {
    totalW = arrowTotalW;
    totalH = headSize * 2;
  } else if (layout === 'text-only') {
    totalW = textW;
    totalH = fs;
  } else {
    totalW = (showText ? textW : 0) + (showText && showArrow ? gap : 0) + arrowTotalW;
    totalH = Math.max(showText ? fs : 0, headSize * 2);
  }

  const ax = ha === 'left'   ? slotX
           : ha === 'right'  ? slotX + slotW - totalW
           : slotX + (slotW - totalW) / 2;
  const ay = va === 'top'    ? slotY
           : va === 'bottom' ? slotY + slotH - totalH
           : slotY + (slotH - totalH) / 2;

  ctx.fillStyle = style.textColor;
  ctx.textBaseline = 'alphabetic';

  if (layout === 'stacked') {
    if (showText) {
      ctx.font = `${style.fontWeight} ${fs}px ${fontCss}`;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${lsPx}px`;
      ctx.fillStyle = style.textColor;
      const tx = ax + (totalW - textW) / 2;
      ctx.fillText(text, tx, ay + fs * 0.78);
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
    }
    if (showArrow) {
      const arrowTop = ay + (showText ? fs + gap : 0);
      const acx = ax + totalW / 2;
      const acy = arrowTop + headSize;
      drawSwipeArrow(ctx, style, dir, acx, acy, arrowLen, headSize);
    }
  } else if (layout === 'arrow-only') {
    const acx = ax + totalW / 2;
    const acy = ay + totalH / 2;
    drawSwipeArrow(ctx, style, dir, acx, acy, arrowLen, headSize);
  } else if (layout === 'text-only') {
    ctx.font = `${style.fontWeight} ${fs}px ${fontCss}`;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${lsPx}px`;
    ctx.fillStyle = style.textColor;
    ctx.fillText(text, ax, ay + totalH * 0.78);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  } else if (layout === 'text-arrow') {
    let cx2 = ax;
    if (showText) {
      ctx.font = `${style.fontWeight} ${fs}px ${fontCss}`;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${lsPx}px`;
      ctx.fillStyle = style.textColor;
      ctx.fillText(text, cx2, ay + totalH * 0.78);
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
      cx2 += textW + gap;
    }
    if (showArrow) {
      const acx = cx2 + arrowTotalW / 2;
      const acy = ay + totalH / 2;
      drawSwipeArrow(ctx, style, dir, acx, acy, arrowLen, headSize);
    }
  } else { // arrow-text
    let cx2 = ax;
    if (showArrow) {
      const acx = cx2 + arrowTotalW / 2;
      const acy = ay + totalH / 2;
      drawSwipeArrow(ctx, style, dir, acx, acy, arrowLen, headSize);
      cx2 += arrowTotalW + gap;
    }
    if (showText) {
      ctx.font = `${style.fontWeight} ${fs}px ${fontCss}`;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${lsPx}px`;
      ctx.fillStyle = style.textColor;
      ctx.fillText(text, cx2, ay + totalH * 0.78);
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
    }
  }

  ctx.restore();
}
