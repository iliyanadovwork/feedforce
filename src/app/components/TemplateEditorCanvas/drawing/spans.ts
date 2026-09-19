import type { TextSpan, CarouselTextAlign } from '../../templateEditorTypes';

export function wrapTextOffsets(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): { line: string; offset: number }[] {
  const words = text.split(' ');
  const result: { line: string; offset: number }[] = [];
  let current = '';
  let currentStart = 0;
  let pos = 0;
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      result.push({ line: current, offset: currentStart });
      currentStart = pos;
      current = word;
    } else {
      current = test;
    }
    pos += word.length + 1;
  }
  if (current) result.push({ line: current, offset: currentStart });
  return result;
}

// Greedy word-wrap that measures each word with its own run's weight/italic, so the canvas breaks lines
// at the same points the browser (contentEditable) does — keeps the inline editor WYSIWYG with the output.
export function wrapSpanLines(
  ctx: CanvasRenderingContext2D,
  spans: TextSpan[],
  paraText: string,
  paraOffset: number,
  maxWidth: number,
  fontCss: string,
  size: number,
  baseWeight: number,
  baseItalic: boolean,
): { line: string; offset: number }[] {
  const setFontAt = (globalOffset: number) => {
    let pos = 0;
    for (const sp of spans) {
      if (globalOffset < pos + sp.text.length) {
        const w  = sp.weight ?? (sp.bold ? Math.max(700, baseWeight) : baseWeight);
        const it = sp.italic ?? baseItalic;
        ctx.font = `${it ? 'italic ' : ''}${w} ${size}px ${fontCss}`;
        return;
      }
      pos += sp.text.length;
    }
    ctx.font = `${baseItalic ? 'italic ' : ''}${baseWeight} ${size}px ${fontCss}`;
  };
  const words = paraText.split(' ');
  const result: { line: string; offset: number }[] = [];
  let current = '';
  let currentStart = 0;
  let pos = 0;
  let lineWidth = 0;
  for (const word of words) {
    setFontAt(paraOffset + pos);
    const wW = ctx.measureText(word).width;
    let sepW = 0;
    if (current) { setFontAt(paraOffset + pos - 1); sepW = ctx.measureText(' ').width; }
    if (current && lineWidth + sepW + wW > maxWidth) {
      result.push({ line: current, offset: currentStart });
      currentStart = pos;
      current = word;
      lineWidth = wW;
    } else {
      current = current ? `${current} ${word}` : word;
      lineWidth += sepW + wW;
    }
    pos += word.length + 1;
  }
  if (current) result.push({ line: current, offset: currentStart });
  return result;
}

const LOREM_WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et ' +
  'dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ' +
  'ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat ' +
  'nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

// Build `count` words of lorem-ipsum filler, plain text in original case (the renderer applies all-caps),
// first word capitalised. The primary/secondary "highlight" alternation is applied at render time via
// alternateWeightSpans, not baked in here.
export function buildFiller(count: number): string {
  const n = Math.max(1, Math.floor(count));
  const placed: string[] = [];
  for (let i = 0; i < n; i++) placed.push(LOREM_WORDS[i % LOREM_WORDS.length]);
  placed[0] = placed[0].charAt(0).toUpperCase() + placed[0].slice(1);
  return placed.join(' ');
}

// Split text into per-word runs whose weight alternates primary/secondary (the "highlight" preview).
// Whitespace runs keep the base weight. Computed at render time so it always reflects the live weights.
export function alternateWeightSpans(text: string, primaryWeight: number, secondaryWeight: number): TextSpan[] {
  const spans: TextSpan[] = [];
  let wordIdx = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/\s/.test(part)) { spans.push({ text: part }); continue; }   // whitespace run, base weight
    spans.push({ text: part, weight: wordIdx % 2 === 1 ? secondaryWeight : primaryWeight });
    wordIdx++;
  }
  return spans;
}

// Default tint for {placeholder} tokens drawn on the canvas — a flat gray so they read like editable
// variables (IDE-style), distinct from the real copy.
export const PLACEHOLDER_TINT = '#9ca3af';

// Build spans that colour {placeholder} tokens (braces included) PLACEHOLDER_TINT; other runs get no
// colour (they inherit the base text colour). Returns null when the text has no token, so callers can
// keep their existing plain-draw path untouched. Token shape matches the automations detector.
export function placeholderSpans(text: string, tint: string = PLACEHOLDER_TINT): TextSpan[] | null {
  if (!text || text.indexOf('{') === -1) return null;
  const re = /\{[a-zA-Z0-9_.-]+\}/g;
  const spans: TextSpan[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    spans.push({ text: m[0], color: tint });
    last = m.index + m[0].length;
  }
  if (spans.length === 0) return null;          // had a '{' but no real token
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

export type LineSeg = { text: string; color?: string; bold?: boolean; italic?: boolean; weight?: number };

export function getLineSpanSegs(
  spans: TextSpan[],
  lineOffset: number,
  lineText: string,
): LineSeg[] {
  const segs: LineSeg[] = [];
  const lineEnd = lineOffset + lineText.length;
  let pos = 0;
  for (const span of spans) {
    const spanEnd = pos + span.text.length;
    const os = Math.max(pos, lineOffset);
    const oe = Math.min(spanEnd, lineEnd);
    if (os < oe) segs.push({ text: lineText.slice(os - lineOffset, oe - lineOffset), color: span.color, bold: span.bold, italic: span.italic, weight: span.weight });
    pos = spanEnd;
  }
  return segs.length > 0 ? segs : [{ text: lineText }];
}

export function drawSpanLine(
  ctx: CanvasRenderingContext2D,
  segs: LineSeg[],
  y: number,
  align: CarouselTextAlign,
  padX: number, maxW: number, canvasW: number,
  fontCss: string, size: number, weight: number, italic: boolean,
  baseColor: string, lsPx: number, sc: number,
  justify = false,   // stretch this line to fill maxW (justified, non-final paragraph line)
) {
  const sp = ctx as CanvasRenderingContext2D & { letterSpacing?: string; wordSpacing?: string };
  sp.letterSpacing = `${(lsPx * sc).toFixed(2)}px`;
  sp.wordSpacing = '0px';
  const segWeight = (seg: LineSeg) => seg.weight ?? (seg.bold ? Math.max(700, weight) : weight);
  let totalW = 0;
  for (const seg of segs) {
    const it = seg.italic ?? italic;
    ctx.font = `${it ? 'italic ' : ''}${segWeight(seg)} ${size}px ${fontCss}`;
    totalW += ctx.measureText(seg.text).width;
  }
  // Justify: widen each word gap so the line fills maxW. measureText then reports the widened widths,
  // so the per-seg x advance below stays correct.
  if (justify && align === 'justify') {
    const gaps = (segs.map(s => s.text).join('').match(/ /g) || []).length;
    if (gaps > 0 && maxW > totalW) sp.wordSpacing = `${((maxW - totalW) / gaps).toFixed(2)}px`;
  }
  // justify (final line) and left both start at padX; centre/right use the natural width.
  const startX = align === 'center' ? (canvasW - totalW) / 2 : align === 'right' ? canvasW - padX - totalW : padX;
  let x = startX;
  ctx.textAlign = 'left';
  for (const seg of segs) {
    const it = seg.italic ?? italic;
    ctx.font = `${it ? 'italic ' : ''}${segWeight(seg)} ${size}px ${fontCss}`;
    ctx.fillStyle = seg.color ?? baseColor;
    ctx.fillText(seg.text, x, y);
    x += ctx.measureText(seg.text).width;
  }
  sp.wordSpacing = '0px';
}

// Fit-to-width layout: lay the text out as N lines where each line's FONT SIZE is scaled so the line spans
// the full box width (poster style). The number of lines is chosen so the stacked block fills the box
// height; words are partitioned to make line widths as equal as possible (DP minimising the widest line),
// so the lines come out a similar size. Honours per-run weights. Returns each line's draw segments + size.
export function layoutFitToWidth(
  ctx: CanvasRenderingContext2D,
  spans: TextSpan[],
  boxWidth: number,
  boxHeight: number,
  lineFactor: number,        // line advance = size * lineFactor
  fontCss: string,
  baseWeight: number,
  baseItalic: boolean,
): { lines: { segs: LineSeg[]; size: number; height: number }[]; totalHeight: number } {
  const REF = 100;   // reference size for measuring; final sizes scale from this
  const sp = ctx as CanvasRenderingContext2D & { letterSpacing?: string; wordSpacing?: string };
  sp.letterSpacing = '0px'; sp.wordSpacing = '0px';

  // Words (with real offsets into the concatenated span text) — whitespace/newlines are word separators.
  const full = spans.map(s => s.text).join('');
  const words: { text: string; start: number }[] = [];
  { const re = /\S+/g; let m: RegExpExecArray | null; while ((m = re.exec(full)) !== null) words.push({ text: m[0], start: m.index }); }
  const M = words.length;
  if (M === 0) return { lines: [], totalHeight: 0 };

  const segWeight = (seg: LineSeg) => seg.weight ?? (seg.bold ? Math.max(700, baseWeight) : baseWeight);
  const wordSegs  = (i: number) => getLineSpanSegs(spans, words[i].start, words[i].text);
  const measureSegs = (segs: LineSeg[]) => {
    let w = 0;
    for (const seg of segs) {
      ctx.font = `${(seg.italic ?? baseItalic) ? 'italic ' : ''}${segWeight(seg)} ${REF}px ${fontCss}`;
      w += ctx.measureText(seg.text).width;
    }
    return w;
  };
  const wordW = words.map((_, i) => measureSegs(wordSegs(i)));
  ctx.font = `${baseItalic ? 'italic ' : ''}${baseWeight} ${REF}px ${fontCss}`;
  const spaceW = ctx.measureText(' ').width;

  const pre = [0]; for (let i = 0; i < M; i++) pre.push(pre[i] + wordW[i]);
  const lineW = (a: number, b: number) => (pre[b] - pre[a]) + (b - a - 1) * spaceW;   // words [a,b) at REF

  // Balanced partition of words into N contiguous lines, minimising the widest line (→ most-equal sizes).
  const partition = (N: number): number[] => {
    const dp: number[][]  = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(Infinity));
    const cut: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
    dp[0][0] = 0;
    for (let k = 1; k <= N; k++) {
      for (let i = k; i <= M; i++) {
        for (let j = k - 1; j < i; j++) {
          if (dp[k - 1][j] === Infinity) continue;
          const w = Math.max(dp[k - 1][j], lineW(j, i));
          if (w < dp[k][i]) { dp[k][i] = w; cut[k][i] = j; }
        }
      }
    }
    const cuts = new Array<number>(N + 1); cuts[N] = M;
    for (let k = N, i = M; k >= 1; k--) { cuts[k - 1] = cut[k][i]; i = cut[k][i]; }
    return cuts;
  };

  // Choose the largest line count whose width-filled block still fits the box height (block height grows
  // with the count). Falls back to one line if even that overflows.
  const maxN = Math.min(M, 12);
  let best: { cuts: number[]; sizes: number[]; blockH: number } | null = null;
  for (let N = 1; N <= maxN; N++) {
    const cuts = partition(N);
    const sizes: number[] = []; let blockH = 0;
    for (let k = 0; k < N; k++) {
      const w = lineW(cuts[k], cuts[k + 1]);
      const size = w > 0 ? (boxWidth * REF) / w : REF;
      sizes.push(size); blockH += size * lineFactor;
    }
    if (blockH <= boxHeight) best = { cuts, sizes, blockH };
  }
  if (!best) {
    const w = lineW(0, M);
    const size = w > 0 ? (boxWidth * REF) / w : REF;
    best = { cuts: [0, M], sizes: [size], blockH: size * lineFactor };
  }
  // Never spill vertically: if the block is taller than the box (only the 1-line fallback can be), shrink
  // it uniformly to fit (it then fills height instead of width).
  let scale = 1;
  if (best.blockH > boxHeight) scale = boxHeight / best.blockH;

  const lines = best.cuts.slice(0, -1).map((a, k) => {
    const b = best!.cuts[k + 1];
    const segs: LineSeg[] = [];
    for (let i = a; i < b; i++) { if (i > a) segs.push({ text: ' ' }); segs.push(...wordSegs(i)); }
    const size = best!.sizes[k] * scale;
    return { segs, size, height: size * lineFactor };
  });
  return { lines, totalHeight: best.blockH * scale };
}

export function spansToHtml(spans: TextSpan[]): string {
  return spans.map(s => {
    const styles: string[] = [];
    if (s.color) styles.push(`color:${s.color}`);
    if (s.weight) styles.push(`font-weight:${s.weight}`);
    else if (s.bold) styles.push('font-weight:700');
    if (s.italic) styles.push('font-style:italic');
    const t = s.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return styles.length > 0 ? `<span style="${styles.join(';')}">${t}</span>` : t;
  }).join('');
}

export function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return rgb;
  return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

export function htmlToSpans(el: HTMLElement): TextSpan[] {
  const list: TextSpan[] = [];
  function walk(node: Node, color?: string, bold?: boolean, italic?: boolean, weight?: number) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (!text) return;
      const s: TextSpan = { text };
      if (color)  s.color  = color;
      if (bold)   s.bold   = true;
      if (italic) s.italic = true;
      if (weight) s.weight = weight;
      list.push(s);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as HTMLElement;
    if (e.tagName === 'BR') { list.push({ text: '\n' }); return; }
    const style = e.style;
    const rawC = style.color || (e.tagName === 'FONT' ? (e.getAttribute('color') ?? undefined) : undefined) || color;
    const c = rawC ? (rawC.startsWith('rgb') ? rgbToHex(rawC) : rawC) : undefined;
    const fwNum = parseInt(style.fontWeight || '');
    const nweight = (Number.isFinite(fwNum) && fwNum >= 100) ? fwNum : weight;   // explicit numeric weight wins
    const b  = (e.tagName === 'B' || e.tagName === 'STRONG' || style.fontWeight === 'bold') ? true : bold;
    const it = (e.tagName === 'I' || e.tagName === 'EM' || style.fontStyle === 'italic') ? true : italic;
    for (const child of Array.from(e.childNodes)) walk(child, c, b, it, nweight);
  }
  for (const child of Array.from(el.childNodes)) walk(child);
  const merged: TextSpan[] = [];
  for (const s of list) {
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.color === s.color && prev.bold === s.bold && prev.italic === s.italic && prev.weight === s.weight) { prev.text += s.text; continue; }
    }
    merged.push({ ...s });
  }
  return merged;
}
