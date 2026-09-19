'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import TemplateEditorCanvas, { CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H } from '@/app/components/TemplateEditorCanvas';
import { rowToSlide, type SlideRow } from '@/app/components/templateEditorRows';
import { setCustomFonts } from '@/app/components/customFonts';

// Headless render target for scheduled (cron) automation runs. The server's browser loads this page
// with a short-lived token, waits for #render-ready, then screenshots each [data-render-slide] box
// (see lib/automations/serverPublish.ts). Slides render at preview size; the browser's
// deviceScaleFactor upscales the screenshots to full 1080px output. Token-gated data — the page is
// useless without a valid token, so being routable in production is fine.

export default function RenderPostPage() {
  // data-render-root opts this page out of the app's global 90% zoom (globals.css) — screenshots are
  // pixel-math (RENDER_W × deviceScaleFactor in serverPublish.ts) and must render at true scale.
  // useSearchParams requires a Suspense boundary at the page level.
  return <div data-render-root><Suspense fallback={null}><RenderPost /></Suspense></div>;
}

function RenderPost() {
  const { postId } = useParams<{ postId: string }>();
  const sp = useSearchParams();
  const token = sp.get('token') ?? '';
  const exp = sp.get('exp') ?? '';

  const [slides, setSlides] = useState<SlideRow[] | null>(null);
  const [logoSrc, setLogoSrc] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/render/post-data?postId=${encodeURIComponent(postId)}&exp=${encodeURIComponent(exp)}&token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load render data');
        if (cancelled) return;
        setCustomFonts((data.fonts ?? []) as Array<{ id: string; label: string; url: string }>);
        setLogoSrc(typeof data.logoSrc === 'string' ? data.logoSrc : '');
        setSlides(((data.slides ?? []) as Record<string, unknown>[]).map(rowToSlide));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => { cancelled = true; };
  }, [postId, token, exp]);

  // Readiness: wait for fonts, then a settle window for background images / custom elements to draw
  // (mirrors the in-app offscreen renderer's mount wait).
  useEffect(() => {
    if (!slides) return;
    let cancelled = false;
    (async () => {
      try { await document.fonts.ready; } catch { /* draw with fallbacks */ }
      await new Promise(r => setTimeout(r, 1500));
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [slides]);

  if (error) return <div id="render-error" style={{ color: '#fff', padding: 16 }}>{error}</div>;
  if (!slides) return null;

  return (
    <div style={{ background: '#000', display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
      {slides.map((s, i) => (
        <div key={s.id} data-render-slide={i} style={{ width: CAROUSEL_PREVIEW_W, height: CAROUSEL_PREVIEW_H, overflow: 'hidden', flexShrink: 0 }}>
          <TemplateEditorCanvas
            imageSrc=""
            headline={s.headline}
            subheadline={s.subheadline}
            settings={s.settings}
            brandLogoSrc={logoSrc || undefined}
            rectMode
            staticMode
            cleanView
            invertedSlots={i === 2}
          />
        </div>
      ))}
      {ready && <div id="render-ready" data-count={slides.length} />}
    </div>
  );
}
