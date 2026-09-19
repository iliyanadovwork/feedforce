'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SignUpResult } from '@/app/hooks/useAuth';
import { AuthForm } from '@/app/components/AuthForm';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { JoinNowContext } from '@/components/join-now';
import { AnalyticsBoardSection } from '@/components/analytics-board';
import { AutomationFlowSection } from '@/components/automation-flow';
import { CapabilitiesSection } from '@/components/capabilities-section';
import { DataTemplateSection } from '@/components/data-template';
import { FilmPlayer } from '@/components/film-section';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { HeroSection } from '@/components/hero';
import { HowItWorks } from '@/components/how-it-works';
import { IntegrationsMarqueeSection } from '@/components/integrations-marquee';
import { OutcomesSection } from '@/components/outcomes-section';
import { PostsMarquee } from '@/components/posts-marquee';
import { RepostFlowSection } from '@/components/repost-flow';
import { Reveal } from '@/components/reveal';
import { TemplateBuilderSection } from '@/components/template-builder';
import { TestimonialsSection } from '@/components/testimonials-section';
import { VisionSection } from '@/components/vision-section';

// ── FeedForce marketing landing ───────────────────────────────────────────────────────────────────
// Shown at "/" for logged-out visitors (see page.tsx). Ported from the FeedForce site; every
// "Join Now" CTA opens the AuthForm overlay (signup first — the form has a sign-in toggle).
// The .ff-landing wrapper scopes the shadcn-style tokens defined in globals.css; the auth overlay
// is rendered OUTSIDE it so the app's own design tokens apply there untouched.

interface FeedforceLandingProps {
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onSignUp: (email: string, password: string) => Promise<SignUpResult>;
  onResetPassword: (email: string) => Promise<string | null>;
}

// Structured data for Google's rich results. Lives here (not the root layout) because the
// landing is the page it describes — and it's what crawlers get at "/" since SSR renders
// the logged-out branch.
const STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'FeedForce',
  url: 'https://feedforce.ai',
  applicationCategory: 'DesignApplication',
  operatingSystem: 'Web',
  description:
    'Build automation workflows that turn live signals and news into on-brand content researched, designed, and published across every channel before the moment passes. Branded carousels, reels, and templates on autopilot.',
});

export function FeedforceLanding({ onSignIn, onSignUp, onResetPassword }: FeedforceLandingProps) {
  const [authMode, setAuthMode] = useState<null | 'login' | 'signup'>(null);
  const openSignup = () => setAuthMode('signup');
  const authCtas = useMemo(
    () => ({ join: () => setAuthMode('signup'), login: () => setAuthMode('login') }),
    [],
  );

  // The landing is pure black but the app's body background is --surface-page (#0a0a0a), and the
  // browser paints overscroll (macOS rubber-band) with the canvas color — so without this, a
  // slightly lighter strip shows when bouncing past the top/bottom. Match the canvas to the
  // landing while it's mounted; restore on unmount so the studio keeps its own tone.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.backgroundColor;
    html.style.backgroundColor = '#000';
    return () => { html.style.backgroundColor = prev; };
  }, []);

  // Lock body scroll while the auth overlay is open.
  useEffect(() => {
    if (!authMode) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAuthMode(null); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
  }, [authMode]);

  return (
    <JoinNowContext.Provider value={authCtas}>
      <div className="dark ff-landing min-h-screen w-full bg-black text-zinc-100 antialiased">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: STRUCTURED_DATA }} />
        <Header />

        <main>
          {/* Hero */}
          <section className="relative overflow-hidden">
            <HeroSection />
          </section>

          {/* Product film over the live posts showcase — the 2 big animated
              rows keep their original spot below the hero, streaming BEHIND
              the centered 16:9 player (same layering as the final CTA). */}
          <section className="relative overflow-hidden pb-28">
            <div className="pointer-events-none absolute inset-0 mt-8 flex -translate-y-10 flex-col justify-center">
              <PostsMarquee rows={2} label="" className="mt-0" />
              <div className="absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-black to-transparent" />
              <div className="absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-black to-transparent" />
            </div>
            {/* Shade over the animation so the player in front pops. */}
            <div className="pointer-events-none absolute inset-0 bg-black/65" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_65%_at_center,rgba(0,0,0,0.9),rgba(0,0,0,0.35))]" />
            <div className="relative z-10 mx-auto mt-8 max-w-7xl px-2 sm:px-6">
              <FilmPlayer />
            </div>
          </section>

          {/* Vision */}
          <VisionSection />

          {/* How it works — 3 cards */}
          <HowItWorks />

          {/* AI node automations — chat panel + node canvas */}
          <AutomationFlowSection />

          {/* Template builder — skeleton → filled demo */}
          <TemplateBuilderSection />

          {/* Dynamic templates — live data bound into a rendered post */}
          <DataTemplateSection />

          {/* Integrations marquee */}
          <IntegrationsMarqueeSection />

          {/* Repost from a link — 3-step flow */}
          <RepostFlowSection />

          {/* Analytics board */}
          <AnalyticsBoardSection />

          {/* Outcomes + weekly queue */}
          <OutcomesSection />

          {/* Platform capabilities */}
          <CapabilitiesSection />

          {/* Social proof */}
          <section className="border-t border-white/5 px-2 sm:px-6 py-24">
            <TestimonialsSection />
          </section>

          {/* Final CTA — mini posts moving behind */}
          <section className="relative mb-28 overflow-hidden border-t border-white/5 px-2 sm:px-6 py-36 text-center sm:mb-36">
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-center opacity-50">
              <PostsMarquee
                rows={5}
                label=""
                gap={14}
                repeat={3}
                heightClassName="h-20 sm:h-24"
                className="mt-0 w-full"
              />
            </div>
            <div className="pointer-events-none absolute inset-0 bg-black/35" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_65%_at_center,rgba(0,0,0,0.9),rgba(0,0,0,0.3))]" />

            <Reveal className="relative z-10">
              <h2 className="mx-auto max-w-2xl text-balance text-[3rem]/[1] font-semibold tracking-tight">
                Ready to scale? Create once, publish forever.
              </h2>
              <p className="mx-auto mt-5 max-w-md text-zinc-400">
                Turn your content operation into an autonomous growth machine. You
                define the system. FeedForce runs it.
              </p>
              <div className="mt-9 flex items-center justify-center">
                <Button
                  className="h-12 rounded-full bg-zinc-100 px-7 text-[1rem]/[1.5rem] font-medium text-zinc-900 hover:bg-white"
                  onClick={openSignup}
                >
                  Join Now
                </Button>
              </div>
            </Reveal>
          </section>
        </main>

        <Footer />
      </div>

      {/* ── Auth overlay (outside .ff-landing so app tokens apply) ─────────────
          data-force-theme: the landing is ALWAYS dark, so this card must stay on dark tokens even
          when the user's app theme is light — the attribute re-applies the dark token set to this
          subtree (globals.css DESIGN TOKENS). */}
      {authMode && (
        <div
          data-force-theme="dark"
          className="de-overlay-in fixed inset-0 z-modal grid place-items-center overflow-y-auto bg-[var(--scrim)] p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setAuthMode(null); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Sign in to FeedForce"
            className="de-dialog-in relative w-full max-w-sm rounded-2xl border border-line bg-page p-7 shadow-3"
            onMouseDown={e => e.stopPropagation()}
          >
            <button
              onClick={() => setAuthMode(null)}
              aria-label="Close"
              className="absolute right-3 top-3 grid size-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-ring"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <div className="mb-5 flex justify-center">
              {/* No ff-logo class here: this dialog is force-dark (see the overlay wrapper), so the
                  white mark must NOT get the light-theme invert — it stays white on the dark card. */}
              <Logo className="h-8" />
            </div>
            <AuthForm
              key={authMode}
              initialMode={authMode}
              onSignIn={onSignIn}
              onSignUp={onSignUp}
              onResetPassword={onResetPassword}
            />
          </div>
        </div>
      )}
    </JoinNowContext.Provider>
  );
}
