import type { ElementInput } from './runtime';

// A reference custom element — a real, working draw-function written to the same contract the AI must
// follow (§4.1: everything relative to props.width/height, animated by props.progress, themed via
// props.theme, data-bindable via inputSchema). Used to validate the runtime in Phase 1 and as a few-shot
// example for the generator in Phase 2.
export interface SampleElement {
  name: string;
  description: string;
  code: string;
  inputSchema: ElementInput[];
  defaultData: unknown;
  size: { w: number; h: number; aspect: number };
}

// A simple animated bar chart. Note: NO hardcoded canvas dimensions — only props.width/height.
const BAR_CHART_CODE = `
const { width: w, height: h, progress, theme } = props;
const series = Array.isArray(props.data) ? props.data
  : (props.data && Array.isArray(props.data.values) ? props.data.values : []);
const vals = series.map(d => (typeof d === 'number' ? d : Number(d && d.value))).filter(v => isFinite(v));
if (vals.length === 0) { return; }

const padX = w * 0.06, padTop = h * 0.10, padBot = h * 0.16;
const plotW = w - padX * 2, plotH = h - padTop - padBot;
const max = Math.max(...vals, 0), min = Math.min(...vals, 0);
const range = (max - min) || 1;
const gap = plotW * 0.04 / Math.max(1, vals.length);
const bw = (plotW - gap * (vals.length - 1)) / vals.length;
const zeroY = padTop + plotH * (max / range);

ctx.font = (Math.round(h * 0.07)) + 'px ' + theme.fontFamily;
ctx.textAlign = 'center';

for (let i = 0; i < vals.length; i++) {
  const v = vals[i];
  const full = (Math.abs(v) / range) * plotH;
  const bh = full * progress;                       // grow up to its height as progress 0→1
  const x = padX + i * (bw + gap);
  const y = v >= 0 ? zeroY - bh : zeroY;
  ctx.fillStyle = v >= 0 ? theme.positive : theme.negative;
  ctx.fillRect(x, y, bw, bh);
}

// baseline
ctx.strokeStyle = theme.muted;
ctx.lineWidth = Math.max(1, h * 0.004);
ctx.beginPath();
ctx.moveTo(padX, zeroY);
ctx.lineTo(w - padX, zeroY);
ctx.stroke();
`.trim();

export const SAMPLE_BAR_CHART: SampleElement = {
  name: 'Bar chart',
  description: 'An animated bar chart that grows from the baseline; positive bars use the accent/positive colour, negative bars the negative colour.',
  code: BAR_CHART_CODE,
  inputSchema: [
    { key: 'values', label: 'Values', dataType: 'series', required: true, description: 'Array of numbers (or { value } objects) — one bar each.' },
  ],
  defaultData: { values: [4, 7, 3, 9, 6, 8, 5] },
  size: { w: 720, h: 460, aspect: 720 / 460 },
};
