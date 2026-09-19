'use client';

import { resolveCarouselFont } from './customFonts';
import type { SwipeStyle } from './templateEditorTypes';

const CANVAS_FULL_W = 1080;
const CAROUSEL_PREVIEW_W = 410;
const LOGO_PH = 28;
const PREV_SCALE = CAROUSEL_PREVIEW_W / CANVAS_FULL_W;
const ZONE_VW = Math.round(CAROUSEL_PREVIEW_W / 3);
const ZONE_VH = LOGO_PH;

export function TemplateEditorSwipePreviewMini({ style }: { style: SwipeStyle }) {
  const VW = ZONE_VW, VH = ZONE_VH;
  const sc = PREV_SCALE;
  const dir = style.direction === 'right' ? 1 : -1;
  const rawText = style.text ?? '';
  const text = style.allCaps ? rawText.toUpperCase() : rawText;
  const layout = style.layout;
  const showText  = layout !== 'arrow-only' && text.length > 0;
  const showArrow = layout !== 'text-only';

  const fs       = style.fontSize * sc;
  const lsPx     = (style.letterSpacing ?? 0) * sc;
  const arrowLen = (style.arrowType !== 'chevron' && style.arrowType !== 'double-chevron')
    ? (style.arrowLength ?? 60) * sc : 0;
  const headSize = (style.arrowHeadSize ?? 10) * sc;
  const gap      = (style.gap ?? 12) * sc;
  const lw       = (style.arrowWeight ?? 2) * sc;
  const stroke   = style.arrowColor;

  const charW       = fs * 0.55;
  const textW       = showText ? text.length * charW + lsPx * Math.max(0, text.length - 1) : 0;
  const arrowTotalW = showArrow ? arrowLen + headSize * 1.2 : 0;

  let totalW = 0, totalH = 0;
  if (layout === 'stacked') {
    totalW = Math.max(showText ? textW : 0, arrowTotalW);
    totalH = (showText ? fs : 0) + (showText && showArrow ? gap : 0) + (showArrow ? headSize * 2 : 0);
  } else if (layout === 'arrow-only') {
    totalW = arrowTotalW; totalH = headSize * 2;
  } else if (layout === 'text-only') {
    totalW = textW; totalH = fs;
  } else {
    totalW = (showText ? textW : 0) + (showText && showArrow ? gap : 0) + arrowTotalW;
    totalH = Math.max(showText ? fs : 0, headSize * 2);
  }
  totalW = Math.min(Math.max(1, totalW), VW - 2);

  const ax = (VW - totalW) / 2;
  const ay = (VH - totalH) / 2;

  const cp = { stroke, fill: 'none', strokeWidth: lw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  // Plain render helpers (not components): defining components during render
  // creates a new type each pass and remounts the subtree.
  function renderArrow(cx: number, cy: number) {
    const tipX = cx + dir * arrowLen / 2;
    const tailX = cx - dir * arrowLen / 2;
    const hl = headSize * 0.9;
    switch (style.arrowType) {
      case 'line': return <>
        <line x1={tailX} y1={cy} x2={tipX - dir * hl * 0.5} y2={cy} {...cp} />
        <polyline points={`${tipX-dir*hl},${cy-headSize} ${tipX},${cy} ${tipX-dir*hl},${cy+headSize}`} {...cp} />
      </>;
      case 'curved': {
        const r = arrowLen * 0.55;
        const acx = cx, acy = cy + r;
        const sa = -Math.PI/2 - dir*0.6, ea = -Math.PI/2 + dir*0.6;
        const sx = acx + r*Math.cos(sa), sy = acy + r*Math.sin(sa);
        const ex = acx + r*Math.cos(ea), ey = acy + r*Math.sin(ea);
        return <>
          <path d={`M${sx},${sy} A${r},${r} 0 0,${dir===1?1:0} ${ex},${ey}`} {...cp} />
          <polyline points={`${ex-dir*hl},${ey-headSize} ${ex},${ey} ${ex-dir*hl},${ey+headSize}`} {...cp} />
        </>;
      }
      case 'chevron':
        return <polyline points={`${tipX-dir*hl},${cy-headSize} ${tipX},${cy} ${tipX-dir*hl},${cy+headSize}`} {...cp} />;
      case 'double-chevron': {
        const off = hl * 0.7;
        return <>
          <polyline points={`${tipX-dir*hl-dir*off},${cy-headSize} ${tipX-dir*off},${cy} ${tipX-dir*hl-dir*off},${cy+headSize}`} {...cp} />
          <polyline points={`${tipX-dir*hl},${cy-headSize} ${tipX},${cy} ${tipX-dir*hl},${cy+headSize}`} {...cp} />
        </>;
      }
      case 'triangle': return <>
        {arrowLen > hl && <line x1={tailX} y1={cy} x2={tipX-dir*hl} y2={cy} {...cp} />}
        <polygon points={`${tipX},${cy} ${tipX-dir*hl},${cy-headSize} ${tipX-dir*hl},${cy+headSize}`} fill={stroke} stroke="none" />
      </>;
      default: return null;
    }
  }

  const fontCss = resolveCarouselFont(style.fontLabel).css;

  function renderLabel(x: number, y: number, anchor: 'start' | 'middle' | 'end' | 'inherit' = 'start') {
    return <text x={x} y={y} textAnchor={anchor} fontSize={fs} fontFamily={fontCss}
      fontWeight={style.fontWeight} fill={style.textColor} letterSpacing={lsPx}>{text}</text>;
  }

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height={VH} style={{ display: 'block', overflow: 'visible' }}>
      {layout === 'stacked' ? <>
        {showText && renderLabel(ax + totalW/2, ay + fs*0.82, 'middle')}
        {showArrow && renderArrow(ax + totalW/2, ay + (showText ? fs + gap : 0) + headSize)}
      </> : layout === 'arrow-only' ? (
        renderArrow(ax + totalW/2, ay + totalH/2)
      ) : layout === 'text-only' ? (
        renderLabel(ax, ay + totalH*0.82)
      ) : layout === 'text-arrow' ? <>
        {showText && renderLabel(ax, ay + totalH*0.82)}
        {showArrow && renderArrow(ax + (showText ? textW + gap : 0) + arrowTotalW/2, ay + totalH/2)}
      </> : <>
        {showArrow && renderArrow(ax + arrowTotalW/2, ay + totalH/2)}
        {showText && renderLabel(ax + (showArrow ? arrowTotalW + gap : 0), ay + totalH*0.82)}
      </>}
    </svg>
  );
}
