'use client';

import { useRef, useState, useEffect } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Modal, Button, Slider } from '@/app/components/ui';
import type { TwitterAvatarShape } from './twitterTemplateTypes';

const FRAME = 300;   // crop-frame size in the modal (px)
const ZOOM_MIN = 0.3;   // below 1 the pfp shrinks inside the frame (header bg shows around it)
const ZOOM_MAX = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

// Interactive avatar cropper: drag to reposition + zoom, in a circle/rounded frame. The (scale,
// offsetX, offsetY) it emits map 1:1 onto the canvas crop in drawHeader.ts (cover × zoom, panned by
// the normalized offset), so the popup preview matches the rendered overlay exactly.
// Mounted only while open (see the panel), so the working copy initialises fresh from props each time.
export function AvatarAdjustModal({
  onClose, imageSrc, shape, bgColor, scale, offsetX, offsetY, onChange,
}: {
  onClose: () => void;
  imageSrc: string;
  shape: TwitterAvatarShape;
  bgColor: string;   // header background — shows around the pfp when zoomed below 1, matching the overlay
  scale: number;
  offsetX: number;
  offsetY: number;
  onChange: (v: { scale: number; offsetX: number; offsetY: number }) => void;
}) {
  // Working copy so Cancel reverts cleanly.
  const [z, setZ] = useState(() => clamp(scale || 1, ZOOM_MIN, ZOOM_MAX));
  const [oX, setOX] = useState(offsetX || 0);
  const [oY, setOY] = useState(offsetY || 0);
  const [dims, setDims] = useState<{ iw: number; ih: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; oX: number; oY: number } | null>(null);

  // Load the natural dimensions so the preview cover-fit matches the canvas.
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (alive) setDims({ iw: img.naturalWidth, ih: img.naturalHeight }); };
    img.src = imageSrc;
    return () => { alive = false; };
  }, [imageSrc]);

  // Display geometry: cover-fit the image to the frame, then apply zoom.
  const cover = dims ? Math.max(FRAME / dims.iw, FRAME / dims.ih) : 1;
  const dispW = dims ? dims.iw * cover * z : FRAME * z;
  const dispH = dims ? dims.ih * cover * z : FRAME * z;
  const maxTX = Math.abs(dispW - FRAME) / 2;   // abs so a shrunk image (zoom < 1) can also be panned
  const maxTY = Math.abs(dispH - FRAME) / 2;
  const tx = oX * maxTX;   // image translation in px (oX>0 → image pulled right)
  const ty = oY * maxTY;

  function onPointerDown(e: ReactPointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, oX, oY };
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const nX = maxTX > 0 ? clamp(d.oX + (e.clientX - d.x) / maxTX, -1, 1) : 0;
    const nY = maxTY > 0 ? clamp(d.oY + (e.clientY - d.y) / maxTY, -1, 1) : 0;
    setOX(nX);
    setOY(nY);
  }
  function onPointerUp() { dragRef.current = null; }

  const radius = shape === 'circle' ? '50%' : `${Math.round(FRAME * 16 / 108)}px`;   // proportional to the canvas corner

  function done() { onChange({ scale: round2(z), offsetX: round2(oX), offsetY: round2(oY) }); onClose(); }
  function reset() { setZ(1); setOX(0); setOY(0); }

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust avatar"
      size="md"
      footer={
        <div className="flex items-center justify-between w-full">
          <Button variant="ghost" size="sm" onClick={reset}>Reset</Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={done}>Done</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <div
          className="relative overflow-hidden cursor-grab active:cursor-grabbing select-none touch-none"
          style={{ width: FRAME, height: FRAME, borderRadius: radius, background: bgColor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <div
            className="absolute left-1/2 top-1/2 pointer-events-none"
            style={{
              width: dispW,
              height: dispH,
              backgroundImage: `url("${imageSrc}")`,
              backgroundSize: '100% 100%',
              backgroundRepeat: 'no-repeat',
              transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`,
            }}
          />
          <div className="pointer-events-none absolute inset-0 ring-1 ring-white/25" style={{ borderRadius: radius }} />
        </div>

        <div className="w-[300px]">
          <Slider label="Zoom" value={z} min={ZOOM_MIN} max={ZOOM_MAX} step={0.05} unit="x" onChange={v => setZ(round2(v))} />
        </div>
        <p className="text-caption text-fg-3">Drag the image to reposition.</p>
      </div>
    </Modal>
  );
}
