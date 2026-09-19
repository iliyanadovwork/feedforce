'use client';

import { useId } from 'react';

// The AI presence mascot — a stacked-ellipse creature with three states that map to the copilot
// lifecycle: `static` (resting), `idle` (breathing + blinking → alive & listening), and `loading`
// (hopping → working). Pure inline SVG + CSS: no assets, no network, no JS animation loop.
//
// Theming: the body draws in `currentColor` (so it inherits the surrounding text color and adapts to
// light/dark or a brand tint); the eyes are punched-out holes that reveal the panel background
// behind, so they read correctly on any surface. Honors prefers-reduced-motion (animations off) —
// callers should keep a text label beside the loading state so "working" is still communicated.
//
// One fixed viewBox across all states (the loading hop needs vertical headroom) so switching state
// never shifts layout. Mask id is per-instance (useId) so multiple mascots don't collide.

export type MascotState = 'static' | 'idle' | 'loading';

export function AiMascot({ state = 'idle', size = 40, className = '', title }: {
  state?: MascotState;
  size?: number;
  className?: string;
  title?: string;
}) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const maskId = `mascot-${rawId}`;
  // Height:width ratio of the shared viewBox (72 × 86.5).
  const height = Math.round((size * 86.5 / 72) * 10) / 10;

  return (
    <span
      className={`inline-block ${className}`}
      style={{ width: size, height, color: 'inherit', lineHeight: 0 }}
      role="img"
      aria-label={title ?? (state === 'loading' ? 'AI is working' : 'AI assistant')}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={height}
        viewBox="24 23.5 72 86.5"
        className={`aimascot aimascot-${state}`}
      >
        <style>{`
          .aimascot .m-breath, .aimascot .m-hop, .aimascot .m-eye { transform-box: fill-box; }
          /* idle: gentle breathing + natural blink */
          .aimascot-idle .m-breath { transform-origin: 50% 100%; animation: mascotBreath 3.4s ease-in-out infinite; }
          .aimascot-idle .m-eye { transform-origin: center; animation: mascotBlink 4s infinite; }
          /* loading: the three tiers hop in sequence with squash-and-stretch + eye jiggle */
          .aimascot-loading .m-hop { transform-origin: 50% 100%; animation-duration: 1.47s; animation-iteration-count: infinite; }
          .aimascot-loading .m-hop1 { animation-name: mascotHop1; }
          .aimascot-loading .m-hop2 { animation-name: mascotHop2; }
          .aimascot-loading .m-hop3 { animation-name: mascotHop3; }
          .aimascot-loading .m-eye { transform-origin: center; animation: mascotEyeJiggle 1.47s ease-in-out infinite; }

          @keyframes mascotBreath { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(1.02); } }
          @keyframes mascotBlink { 0%, 4%, 10%, 100% { transform: scaleY(1); } 6% { transform: scaleY(0.08); } }
          @keyframes mascotHop1 {
            0%, 4%, 46%, 100% { transform: translateY(0) scale(1,1); animation-timing-function: ease-in-out; }
            8%  { transform: translateY(0) scale(1.05,0.94); animation-timing-function: cubic-bezier(.35,.6,.45,1); }
            11% { transform: translateY(-1px) scale(0.97,1.04); animation-timing-function: cubic-bezier(.33,.67,.67,1); }
            21% { transform: translateY(-5px) scale(1,1); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
            31% { transform: translateY(0) scale(1.07,0.93); animation-timing-function: cubic-bezier(.33,.67,.67,1); }
            35% { transform: translateY(-0.6px) scale(1,1); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
            39% { transform: translateY(0) scale(1.02,0.98); animation-timing-function: ease-out; }
          }
          @keyframes mascotHop2 {
            0%, 9%, 54%, 100% { transform: translateY(0) scale(1,1); animation-timing-function: ease-in-out; }
            13% { transform: translateY(0) scale(1.05,0.94); animation-timing-function: cubic-bezier(.35,.6,.45,1); }
            16% { transform: translateY(-1.2px) scale(0.97,1.05); animation-timing-function: cubic-bezier(.33,.67,.67,1); }
            27% { transform: translateY(-7px) scale(1,1); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
            38% { transform: translateY(0) scale(1.06,0.94); animation-timing-function: cubic-bezier(.33,.67,.67,1); }
            42% { transform: translateY(-1.1px) scale(1,1); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
            47% { transform: translateY(0) scale(1.02,0.98); animation-timing-function: ease-out; }
          }
          @keyframes mascotHop3 {
            0%, 18%, 65%, 100% { transform: translateY(0) scale(1,1); animation-timing-function: ease-in-out; }
            22% { transform: translateY(0) scale(1.04,0.95); animation-timing-function: cubic-bezier(.35,.6,.45,1); }
            25% { transform: translateY(-1.4px) scale(0.96,1.05); animation-timing-function: cubic-bezier(.33,.67,.67,1); }
            37% { transform: translateY(-9px) scale(1,1); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
            49% { transform: translateY(0) scale(1.05,0.94); animation-timing-function: cubic-bezier(.33,.67,.67,1); }
            53% { transform: translateY(-1.6px) scale(1,1); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
            59% { transform: translateY(0) scale(1.02,0.98); animation-timing-function: ease-out; }
          }
          @keyframes mascotEyeJiggle {
            0%, 18%, 68%, 100% { transform: translateY(0); }
            26% { transform: translateY(0.7px); } 37% { transform: translateY(-0.5px); }
            49% { transform: translateY(0.8px); } 56% { transform: translateY(-0.3px); } 62% { transform: translateY(0); }
          }
          @media (prefers-reduced-motion: reduce) {
            .aimascot .m-breath, .aimascot .m-hop, .aimascot .m-eye { animation: none !important; }
          }
        `}</style>
        <defs>
          <mask id={maskId}>
            {/* Body tiers. In loading each tier hops on its own group; idle wraps all three in one
                breathing group; static has no wrapper. Eyes are black (holes) in every state. */}
            {state === 'loading' ? (
              <>
                <g className="m-hop m-hop1"><ellipse cx="60" cy="96" rx="32" ry="14" fill="#fff" /></g>
                <g className="m-hop m-hop2"><ellipse cx="60" cy="70" rx="23" ry="14.5" fill="#fff" /></g>
                <g className="m-hop m-hop3">
                  <ellipse cx="60" cy="44" rx="15.5" ry="11" fill="#fff" />
                  <circle className="m-eye" cx="54.5" cy="42.5" r="2.4" fill="#000" />
                  <circle className="m-eye" cx="65.5" cy="42.5" r="2.4" fill="#000" />
                </g>
              </>
            ) : state === 'idle' ? (
              <g className="m-breath">
                <ellipse cx="60" cy="96" rx="32" ry="14" fill="#fff" />
                <ellipse cx="60" cy="70" rx="23" ry="14.5" fill="#fff" />
                <ellipse cx="60" cy="44" rx="15.5" ry="11" fill="#fff" />
                <circle className="m-eye" cx="54.5" cy="42.5" r="2.4" fill="#000" />
                <circle className="m-eye" cx="65.5" cy="42.5" r="2.4" fill="#000" />
              </g>
            ) : (
              <>
                <ellipse cx="60" cy="96" rx="32" ry="14" fill="#fff" />
                <ellipse cx="60" cy="70" rx="23" ry="14.5" fill="#fff" />
                <ellipse cx="60" cy="44" rx="15.5" ry="11" fill="#fff" />
                <circle cx="54.5" cy="42.5" r="2.4" fill="#000" />
                <circle cx="65.5" cy="42.5" r="2.4" fill="#000" />
              </>
            )}
          </mask>
        </defs>
        {/* The visible body is drawn in currentColor, shaped by the mask. */}
        <rect x="24" y="23.5" width="72" height="86.5" fill="currentColor" mask={`url(#${maskId})`} />
      </svg>
    </span>
  );
}
