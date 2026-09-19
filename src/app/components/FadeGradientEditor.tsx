'use client';

import { useRef, useState } from 'react';
import type { ImageBoxFade, FadeEdge, FadeStop } from './templateEditorTypes';
import { defaultFadeStops, sampleFadeStops } from './templateEditorTypes';
import { IconButton, NumberField, SegmentedControl } from './ui';
import { TrashIcon } from '@/lib/icons';

const EDGES: { key: FadeEdge; label: string }[] = [
  { key: 'top',    label: 'Top' },
  { key: 'bottom', label: 'Bottom' },
  { key: 'left',   label: 'Left' },
  { key: 'right',  label: 'Right' },
];

// Transparency checkerboard for the preview bar's faded regions.
const CHECKER =
  'linear-gradient(45deg,#3f3f46 25%,transparent 25%),linear-gradient(-45deg,#3f3f46 25%,transparent 25%),' +
  'linear-gradient(45deg,transparent 75%,#3f3f46 75%),linear-gradient(-45deg,transparent 75%,#3f3f46 75%)';

// Image visibility (0-1) of a fade curve at a given location (0-100), honouring midpoints.
function visAt(stops: FadeStop[], loc: number): number {
  const s = [...stops].sort((a, b) => a.loc - b.loc);
  if (loc <= s[0].loc) return s[0].opacity / 100;
  if (loc >= s[s.length - 1].loc) return s[s.length - 1].opacity / 100;
  for (let i = 0; i < s.length - 1; i++) {
    const A = s[i], B = s[i + 1];
    if (loc >= A.loc && loc <= B.loc) {
      const span = B.loc - A.loc;
      if (span <= 0) return A.opacity / 100;
      const p = (loc - A.loc) / span;
      const midPct = A.mid ?? 50;
      const t = Math.abs(midPct - 50) < 0.5
        ? p
        : Math.pow(p, Math.log(0.5) / Math.log(Math.min(0.999, Math.max(0.001, midPct / 100))));
      return (A.opacity + (B.opacity - A.opacity) * t) / 100;
    }
  }
  return 1;
}

// Photoshop-style per-edge fade curve editor: draggable opacity stops + midpoint diamonds,
// click the track to add a stop, numeric location/opacity, delete. One curve per edge.
export function FadeGradientEditor({ fade, onChange }: {
  fade: ImageBoxFade;
  onChange: (next: ImageBoxFade) => void;
}) {
  const [edge, setEdge] = useState<FadeEdge>('top');
  const [sel, setSel]   = useState(0);
  const barRef = useRef<HTMLDivElement>(null);

  const stops = fade.stops?.[edge] ?? defaultFadeStops();
  const selStop = stops[Math.min(sel, stops.length - 1)] ?? stops[0];
  const transparent = !fade.color;
  const reach = fade[edge] ?? 0;
  const edgeLabel = EDGES.find(e => e.key === edge)?.label ?? '';

  const writeStops = (next: FadeStop[]) =>
    onChange({ ...fade, stops: { ...(fade.stops ?? {}), [edge]: next } });

  const locFromX = (clientX: number): number => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
  };

  // Drag a stop horizontally (clamped between neighbours) or a midpoint between two stops.
  const beginDrag = (e: React.MouseEvent, kind: 'stop' | 'mid', index: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (kind === 'stop') setSel(index);
    const start = stops.map(s => ({ ...s }));
    const onMove = (ev: MouseEvent) => {
      const loc = locFromX(ev.clientX);
      if (kind === 'stop') {
        const lo = index > 0 ? start[index - 1].loc + 0.5 : 0;
        const hi = index < start.length - 1 ? start[index + 1].loc - 0.5 : 100;
        writeStops(start.map((s, i) => i === index ? { ...s, loc: Math.round(Math.min(hi, Math.max(lo, loc))) } : s));
      } else {
        const A = start[index], B = start[index + 1];
        const span = B.loc - A.loc;
        const mid = span <= 0 ? 50 : Math.min(95, Math.max(5, ((loc - A.loc) / span) * 100));
        writeStops(start.map((s, i) => i === index ? { ...s, mid: Math.round(mid) } : s));
      }
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Click the track (not a handle) → insert a stop on the existing curve at that location.
  const addStop = (e: React.MouseEvent) => {
    const loc = Math.round(locFromX(e.clientX));
    if (stops.some(s => Math.abs(s.loc - loc) < 1)) return;
    const created: FadeStop = { loc, opacity: Math.round(visAt(stops, loc) * 100), mid: 50 };
    const next = [...stops, created].sort((a, b) => a.loc - b.loc);
    writeStops(next);
    setSel(next.indexOf(created));
  };

  const delStop = () => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, i) => i !== sel);
    writeStops(next);
    setSel(Math.max(0, Math.min(sel, next.length - 1)));
  };

  const setSelLoc = (v: number) => {
    const lo = sel > 0 ? stops[sel - 1].loc : 0;
    const hi = sel < stops.length - 1 ? stops[sel + 1].loc : 100;
    writeStops(stops.map((s, i) => i === sel ? { ...s, loc: Math.min(hi, Math.max(lo, v)) } : s));
  };
  const setSelOpacity = (v: number) =>
    writeStops(stops.map((s, i) => i === sel ? { ...s, opacity: Math.min(100, Math.max(0, v)) } : s));

  const samples = sampleFadeStops(stops);
  const overlay = `linear-gradient(to right, ${samples
    .map(s => `rgba(255,255,255,${s.vis.toFixed(3)}) ${(s.pos * 100).toFixed(2)}%`)
    .join(', ')})`;

  return (
    <div className="flex flex-col gap-2 pt-1" onMouseDown={e => e.stopPropagation()}>
      <span className="text-caption text-fg-3 uppercase tracking-wider">Fade curve</span>

      {/* Edge selector */}
      <SegmentedControl
        ariaLabel="Fade edge"
        emphasis="fill"
        className="w-full [&>[role=tab]]:flex-1 [&>[role=tab]]:justify-center"
        items={EDGES.map(ed => ({ value: ed.key, label: ed.label }))}
        value={edge}
        onChange={(v: FadeEdge) => { setEdge(v); setSel(0); }}
      />

      {reach === 0 && (
        <span className="text-caption text-fg-3">Raise the {edgeLabel} reach above to preview this curve.</span>
      )}

      {/* Preview bar + handle track */}
      <div className="select-none">
        <div
          ref={barRef}
          className="relative h-5 rounded-sm overflow-hidden border border-line"
          style={transparent
            ? { backgroundColor: '#27272a', backgroundImage: CHECKER, backgroundSize: '8px 8px', backgroundPosition: '0 0,0 4px,4px -4px,-4px 0' }
            : { backgroundColor: fade.color }}
        >
          <div className="absolute inset-0" style={{ background: overlay }} />
        </div>

        {/* Track: click empty space to add; drag handles to move */}
        <div className="relative h-4 mt-1 cursor-copy" onMouseDown={addStop}>
          {/* Midpoint diamonds (between adjacent stops) */}
          {stops.slice(0, -1).map((A, i) => {
            const B = stops[i + 1];
            const midLoc = A.loc + ((A.mid ?? 50) / 100) * (B.loc - A.loc);
            return (
              <div
                key={`m${i}`}
                onMouseDown={e => beginDrag(e, 'mid', i)}
                title="Midpoint"
                className="absolute w-[7px] h-[7px] bg-zinc-400 border border-zinc-200 cursor-ew-resize"
                style={{ left: `${midLoc}%`, top: 1, transform: 'translateX(-50%) rotate(45deg)' }}
              />
            );
          })}
          {/* Opacity stops */}
          {stops.map((s, i) => (
            <div
              key={`s${i}`}
              onMouseDown={e => beginDrag(e, 'stop', i)}
              className="absolute flex flex-col items-center cursor-ew-resize"
              style={{ left: `${s.loc}%`, top: 0, transform: 'translateX(-50%)' }}
            >
              <div
                style={{
                  width: 0, height: 0,
                  borderLeft: '4px solid transparent',
                  borderRight: '4px solid transparent',
                  borderBottom: `5px solid ${i === sel ? '#60a5fa' : '#a1a1aa'}`,
                }}
              />
              <div
                style={{
                  width: 11, height: 11,
                  backgroundColor: `rgba(255,255,255,${(s.opacity / 100).toFixed(3)})`,
                  border: i === sel ? '2px solid #60a5fa' : '1px solid #a1a1aa',
                  borderRadius: 2,
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Selected stop controls */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-caption text-fg-3">
          Location
          <NumberField
            min={0} max={100} value={Math.round(selStop.loc)}
            onChange={v => setSelLoc(Math.round(v || 0))}
            label="Location"
          />
        </label>
        <label className="flex items-center gap-1.5 text-caption text-fg-3">
          Opacity
          <NumberField
            min={0} max={100} value={Math.round(selStop.opacity)}
            onChange={v => setSelOpacity(Math.round(v || 0))}
            label="Opacity"
          />
        </label>
        <IconButton
          icon={<TrashIcon size={14} />}
          label={stops.length <= 2 ? 'A curve needs at least two stops' : 'Delete stop'}
          variant="danger"
          size="sm"
          onClick={delStop}
          disabled={stops.length <= 2}
          className="ml-auto"
        />
      </div>
    </div>
  );
}
