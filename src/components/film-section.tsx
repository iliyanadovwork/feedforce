'use client';

import { useEffect, useRef, useState } from 'react';
import { Reveal } from '@/components/reveal';
import poster from '@/assets/film-poster.jpg';

// ── Product film ──────────────────────────────────────────────────────────────
// The 16:9 grand trailer (3:02), hosted in the public post-videos bucket under
// marketing/ — a namespace nothing user-owned references, so the media GC and
// the _renders/ cleanup cron can never touch it. Poster ships bundled (fast
// LCP). Autoplays with sound (looping) once it scrolls into view — the film
// only starts downloading then, keeping it off the critical path. Browsers
// that block unmuted autoplay get muted playback with a click-to-unmute pill.
// Renders just the framed player — the landing composes it over the animated
// posts marquee (see feedforce-landing.tsx).
const FILM_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/storage/v1/object/public/post-videos/marketing/feedforce-film-16x9.mp4`;

export function FilmPlayer() {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [withSound, setWithSound] = useState(true);

	// Autoplay once the player is on screen — with sound when the browser
	// allows it. Browsers block unmuted autoplay for visitors who haven't
	// interacted with the site yet, so when the unmuted play() is rejected we
	// fall back to muted playback and surface the Unmute pill.
	useEffect(() => {
		const el = videoRef.current;
		if (!el) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (!entries[0].isIntersecting) return;
				io.disconnect();
				el.muted = false;
				el.play().catch(() => {
					el.muted = true;
					setWithSound(false);
					el.play().catch(() => {
						// Even muted autoplay refused (e.g. data-saver) — leave the
						// poster; the pill click still starts playback.
					});
				});
			},
			{ threshold: 0.25 }
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	const unmute = () => {
		setWithSound(true);
		const el = videoRef.current;
		if (!el) return;
		el.muted = false;
		void el.play();
		// Hand keyboard focus to the native controls (the overlay unmounts).
		el.focus();
	};

	return (
		<Reveal>
			<div className="relative overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
				<video
					ref={videoRef}
					className="aspect-video w-full"
					src={FILM_URL}
					poster={poster.src}
					preload="metadata"
					loop
					playsInline
					controls={withSound}
				/>
				{!withSound && (
					<button
						type="button"
						onClick={unmute}
						aria-label="Play the FeedForce film with sound"
						className="group absolute inset-0"
					>
						<span className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full bg-black/70 px-3.5 py-1.5 text-[0.8125rem]/[1.25rem] font-medium text-zinc-200 transition-colors group-hover:bg-black/90 group-hover:text-white">
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden
							>
								<path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />
							</svg>
							Unmute · 3:02
						</span>
					</button>
				)}
			</div>
		</Reveal>
	);
}
