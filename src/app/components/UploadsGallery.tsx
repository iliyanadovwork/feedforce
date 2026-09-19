'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { BrandLogo } from '../types';
import { IconButton } from './ui';
import { TrashIcon } from '@/lib/icons';

// Tray items can be images or uploaded videos (post-videos bucket / .mp4). Videos render as a muted,
// looping <video> thumbnail instead of an <img>.
const isVid = (u: string) => u.includes('/post-videos/') || /\.mp4($|\?)/i.test(u);

interface UploadsGalleryProps {
  logos: BrandLogo[];
  activeLogoUrl?: string | null;
  onSelect?: (url: string) => void;
  onDelete?: (id: string) => void;
  // When provided, each image becomes draggable with these handlers (e.g. drag onto the canvas)
  dragProps?: (url: string) => { draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void };
}

type LayoutMode = 'compact' | 'normal';
interface ImageMeta { aspect: number; transparent: boolean; mode: LayoutMode }

// Canva-style justified gallery. Variable row heights; rows fill container
// width edge-to-edge (modulo the cap). Card inner area exactly matches each
// image's natural aspect ratio so the image renders with no padding and no
// clipping. Transparent images (PNG/SVG alpha) classify as 'compact' so wide
// wordmarks/icons don't dominate rows; opaque images (photos/screenshots)
// classify as 'normal' and can grow into feature-sized cards.
export function UploadsGallery({
  logos,
  activeLogoUrl,
  onSelect,
  onDelete,
  dragProps,
}: UploadsGalleryProps) {
  const [imageMeta, setImageMeta] = useState<Record<string, ImageMeta>>({});
  const [galleryEl, setGalleryEl] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!galleryEl) return;
    // No manual seed needed: ResizeObserver fires once on observe() with the initial size.
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number' && w > 0) setContainerWidth(w);
    });
    ro.observe(galleryEl);
    return () => ro.disconnect();
  }, [galleryEl]);

  // Probe each image: natural dimensions + transparency on a 32×32 canvas.
  useEffect(() => {
    let cancelled = false;
    logos.forEach(logo => {
      if (imageMeta[logo.id]) return;
      if (isVid(logo.url)) {   // video thumbnail: skip the Image probe; use a default 16:9 cell
        setImageMeta(prev => (prev[logo.id] ? prev : { ...prev, [logo.id]: { aspect: 16 / 9, transparent: false, mode: 'normal' } }));
        return;
      }
      const probe = new globalThis.Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => {
        if (cancelled || !probe.naturalWidth || !probe.naturalHeight) return;
        const aspect = probe.naturalWidth / probe.naturalHeight;
        let transparent = false;
        try {
          const canvas = document.createElement('canvas');
          canvas.width  = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(probe, 0, 0, 32, 32);
            const data = ctx.getImageData(0, 0, 32, 32).data;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] < 200) { transparent = true; break; }
            }
          }
        } catch { /* CORS-tainted canvas — assume opaque */ }
        const mode: LayoutMode = transparent ? 'compact' : 'normal';
        if (cancelled) return;
        setImageMeta(prev => (prev[logo.id] ? prev : { ...prev, [logo.id]: { aspect, transparent, mode } }));
      };
      probe.src = logo.url;
    });
    return () => { cancelled = true; };
  }, [logos, imageMeta]);

  const rows = useMemo(() => {
    if (containerWidth <= 0) return [] as Array<{ items: Array<{ id: string; url: string; width: number; height: number }>; height: number }>;
    const GAP    = 4;
    const BORDER = 2;
    // Justified gallery with a soft height cap. Rows always fill container
    // width edge-to-edge. The cap caps each row's height only if the items
    // already in it collectively have enough "aspect budget" to fill at that
    // height. If they don't (e.g. one solo portrait), we KEEP adding items
    // until sum-of-aspects is large enough to fill at the cap. The last row
    // may still exceed the cap if we run out of items.
    const MAX_INNER = 120 - 2 * BORDER; // ~120px tall cap, tweak to taste

    type RawItem = { id: string; url: string; aspect: number };
    const items: RawItem[] = logos.map(l => ({
      id:     l.id,
      url:    l.url,
      aspect: imageMeta[l.id]?.aspect ?? 1.5,
    }));

    const result: Array<{ items: Array<{ id: string; url: string; width: number; height: number }>; height: number }> = [];
    let current: RawItem[] = [];

    function closeRow() {
      if (current.length === 0) return;
      const sumAspects   = current.reduce((s, it) => s + it.aspect, 0);
      const gapTotal     = (current.length - 1) * GAP;
      const borderTotal  = current.length * 2 * BORDER;
      const availableInner = Math.max(1, containerWidth - gapTotal - borderTotal);
      // Row fills width exactly: card_inner_height = availableInner / sumAspects
      const innerHeight  = availableInner / sumAspects;
      const outerHeight  = innerHeight + 2 * BORDER;
      result.push({
        items: current.map(it => ({
          id:     it.id,
          url:    it.url,
          width:  it.aspect * innerHeight + 2 * BORDER,
          height: outerHeight,
        })),
        height: outerHeight,
      });
      current = [];
    }

    for (const item of items) {
      current.push(item);
      // If the current row at fill-width would already be within the cap, close
      // it. Otherwise keep adding items to grow sum-of-aspects so the fill
      // height drops to/under the cap.
      const sumAspects   = current.reduce((s, it) => s + it.aspect, 0);
      const n            = current.length;
      const gapTotal     = (n - 1) * GAP;
      const borderTotal  = n * 2 * BORDER;
      const availableInner = Math.max(1, containerWidth - gapTotal - borderTotal);
      const innerHeight  = availableInner / sumAspects;
      if (innerHeight <= MAX_INNER) {
        closeRow();
      }
    }
    // Flush any leftover items as the last row (may exceed cap).
    closeRow();
    return result;
  }, [logos, imageMeta, containerWidth]);

  return (
    <div ref={setGalleryEl} className="flex flex-col gap-1 w-full">
      {rows.map((row, ri) => (
        <div key={ri} className="flex gap-1" style={{ height: row.height }}>
          {row.items.map(item => {
            const isActive = activeLogoUrl === item.url;
            return (
              <div
                key={item.id}
                className="relative group shrink-0"
                style={{ width: item.width, height: item.height }}
              >
                <button
                  {...(dragProps ? dragProps(item.url) : {})}
                  onClick={() => onSelect?.(item.url)}
                  className={`focus-ring w-full h-full rounded-md overflow-hidden border-2 transition-colors bg-page block ${
                    isActive ? 'border-accent' : 'border-line hover:border-line-strong'
                  }${dragProps ? ' cursor-grab active:cursor-grabbing' : ''}`}
                >
                  {isVid(item.url) ? (
                    <video
                      src={item.url}
                      muted loop autoPlay playsInline
                      className="block w-full h-full object-cover"
                    />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={item.url}
                      alt=""
                      loading="lazy"
                      className="block w-full h-full object-cover"
                    />
                  )}
                </button>

                {/* Explicit "this is your brand logo" marker on the selected upload. */}
                {isActive && (
                  <span className="pointer-events-none absolute inset-x-1 bottom-1 z-10 truncate rounded bg-accent px-1.5 py-1 text-center text-[10px] font-semibold leading-none text-accent-fg shadow-1">
                    Brand logo
                  </span>
                )}

                {onDelete && (
                  <IconButton
                    icon={<TrashIcon size={10} />}
                    label="Delete upload"
                    variant="danger"
                    onClick={e => { e.stopPropagation(); onDelete(item.id); }}
                    className="absolute -top-1.5 -left-1.5 z-10 size-5 rounded-full bg-surface-3/85 text-fg shadow-2 backdrop-blur-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-[var(--dur-fast)]"
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
