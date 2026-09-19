import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Reveal } from '@/components/reveal';
import { Button } from '@/components/ui/button';

// Public affiliate program landing page (feedforce.ai/affiliates) — pitches the program and sends
// visitors to /affiliates/apply. Distinct from /affiliate (singular, the signed-in affiliate's own
// dashboard) — every export here says "affiliates"/landing explicitly to avoid confusion with it.
// Deliberately a lightweight standalone shell (own header/footer, dark marketing register) rather
// than the homepage's full section stack or its shared Header/Footer — those carry main-product copy
// and CTAs that don't fit an application funnel.

export const metadata: Metadata = {
  title: 'Affiliate Program',
  description: 'Earn recurring commission promoting FeedForce. Apply in minutes, get your own discount code, and get paid for every renewal your referrals make.',
};

const STEPS = [
  { number: '01', title: 'Apply', description: 'Tell us about your audience: website, social handles, and how you\'d promote FeedForce. Takes a couple of minutes.' },
  { number: '02', title: 'Get approved', description: 'We review your application and set your deal: your commission rate and the discount your code gives new customers.' },
  { number: '03', title: 'Earn', description: 'Share your code. You earn a recurring commission on every payment your referrals make, not just the first one.' },
];

const FAQS = [
  { q: 'What do I need to apply?', a: 'A website or at least one social handle (Instagram, TikTok, YouTube, or X), and a quick note on how you\'d promote FeedForce.' },
  { q: 'How much can I earn?', a: 'Commission is a recurring percentage of every payment made by customers who used your code, for as long as they stay subscribed, not just their first payment.' },
  { q: 'What discount does my code give?', a: 'Your code gives new customers a percentage off, for a set number of months (or longer), set when your application is approved.' },
  { q: 'How do I get paid?', a: 'Your dashboard tracks referrals and earnings in real time. Payouts are sent manually, so reach out any time with questions.' },
];

export default function AffiliatesLandingPage() {
  return (
    <div className="dark ff-landing min-h-screen w-full bg-black text-zinc-100 antialiased">
      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-black">
        <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center">
            <Logo className="h-7 w-auto" />
          </Link>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="h-10 rounded-full px-5 text-[0.875rem]/[1.25rem]" render={<Link href="/affiliate" />} nativeButton={false}>
              Affiliate sign in
            </Button>
            <Button className="h-10 rounded-full px-5 text-[0.875rem]/[1.25rem]" render={<Link href="/affiliates/apply" />} nativeButton={false}>
              Apply now
            </Button>
          </div>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden px-6 py-28 text-center sm:py-36">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: 'radial-gradient(rgba(255,255,255,0.16) 1.2px, transparent 1.2px)',
              backgroundSize: '22px 22px',
              maskImage: 'radial-gradient(ellipse 60% 70% at center, black, transparent)',
              WebkitMaskImage: 'radial-gradient(ellipse 60% 70% at center, black, transparent)',
            }}
          />
          <Reveal className="relative z-10">
            <p className="font-mono text-[11px] tracking-widest text-zinc-500">FEEDFORCE AFFILIATE PROGRAM</p>
            <h1 className="mx-auto mt-4 max-w-2xl text-balance text-[2.5rem]/[1.05] font-semibold tracking-tight sm:text-[3.5rem]/[1]">
              Earn recurring commission promoting FeedForce.
            </h1>
            <p className="mx-auto mt-5 max-w-md text-zinc-400">
              Share your code, give your audience a discount, and get paid on every renewal your
              referrals make, for as long as they stay subscribed.
            </p>
            <div className="mt-9 flex items-center justify-center">
              <Button className="h-12 rounded-full bg-zinc-100 px-7 text-[1rem]/[1.5rem] font-medium text-zinc-900 hover:bg-white" render={<Link href="/affiliates/apply" />} nativeButton={false}>
                Apply now
              </Button>
            </div>
          </Reveal>
        </section>

        {/* How it works */}
        <section className="border-t border-white/5 px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="text-balance text-center text-[2rem]/[1.1] font-medium tracking-tight sm:text-[2.75rem]/[1]">
                How it works
              </h2>
            </Reveal>
            <div className="mt-14 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <Reveal key={step.number} delay={i * 100}>
                  <article className="flex h-full flex-col rounded-xl border border-white/10 bg-black p-6 sm:p-7">
                    <span className="font-mono text-[11px] tracking-widest text-zinc-500">{step.number}</span>
                    <h3 className="mt-4 text-[1.375rem]/[1.75rem] font-medium tracking-tight">{step.title}</h3>
                    <p className="mt-3 text-[0.875rem]/[1.25rem] leading-relaxed text-zinc-400">{step.description}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Commission highlight */}
        <section className="border-t border-white/5 px-6 py-24">
          <div className="mx-auto max-w-3xl text-center">
            <Reveal>
              <h2 className="text-balance text-[2rem]/[1.1] font-medium tracking-tight sm:text-[2.75rem]/[1]">
                Recurring commission. A real discount for your audience.
              </h2>
              <p className="mx-auto mt-5 max-w-lg text-zinc-400">
                Your rate and your audience&apos;s discount are set when you&apos;re approved. It&apos;s
                recurring, not a single payout. You earn every time a referral pays, for as long as
                they stay a customer.
              </p>
            </Reveal>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-white/5 px-6 py-24">
          <div className="mx-auto max-w-2xl">
            <Reveal>
              <h2 className="text-balance text-center text-[2rem]/[1.1] font-medium tracking-tight sm:text-[2.75rem]/[1]">
                Questions
              </h2>
            </Reveal>
            <div className="mt-12 flex flex-col gap-8">
              {FAQS.map((f, i) => (
                <Reveal key={f.q} delay={i * 60}>
                  <h3 className="text-[1.0625rem]/[1.5rem] font-medium text-zinc-100">{f.q}</h3>
                  <p className="mt-2 text-[0.9375rem]/[1.375rem] text-zinc-400">{f.a}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-white/5 px-6 py-32 text-center">
          <Reveal>
            <h2 className="mx-auto max-w-xl text-balance text-[2.25rem]/[1.05] font-semibold tracking-tight sm:text-[2.75rem]/[1]">
              Ready to start earning?
            </h2>
            <div className="mt-9 flex items-center justify-center">
              <Button className="h-12 rounded-full bg-zinc-100 px-7 text-[1rem]/[1.5rem] font-medium text-zinc-900 hover:bg-white" render={<Link href="/affiliates/apply" />} nativeButton={false}>
                Apply now
              </Button>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 sm:flex-row">
          <p className="font-light text-zinc-500 text-[0.875rem]/[1.25rem]">
            &copy; {new Date().getFullYear()} FeedForce, All rights reserved
          </p>
          <nav className="flex gap-5 text-[0.875rem]/[1.25rem] text-zinc-500">
            <Link href="/" className="transition-colors hover:text-white">Home</Link>
            <Link href="/terms" className="transition-colors hover:text-white">Terms</Link>
            <Link href="/privacy" className="transition-colors hover:text-white">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
