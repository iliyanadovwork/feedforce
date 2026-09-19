// Startup environment validation.
//
// Next has no single "boot" file, so this is invoked from instrumentation.ts's register() (runs once
// when a server instance starts). It fails fast in PRODUCTION when a CORE var is missing — instead of the
// app booting "green" and then every Supabase call silently hitting the placeholder creds in supabase.ts,
// or the cron 401-ing itself forever because CRON_SECRET is unset. Feature vars only WARN, so a partial
// deploy degrades loudly (in the logs) rather than silently.

const CORE = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SECRET_KEY'] as const;

// Missing these disables a whole feature area but shouldn't hard-crash the app — warn only.
const FEATURE: Record<string, string> = {
  GEMINI_API_KEY: 'AI (copilots, element/caption generation)',
  STRIPE_SECRET_KEY: 'Stripe billing',
  STRIPE_WEBHOOK_SECRET: 'Stripe webhook (subscription + affiliate sync)',
  STRIPE_PRICE_ID: 'Stripe checkout plan',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'Lemon Squeezy webhook',
  CRON_SECRET: 'cron auth (automations + render cleanup)',
  RENDER_TOKEN_SECRET: 'render-token signing (falls back to CRON_SECRET until set — see lib/renderToken.ts)',
  AUTOMATION_SECRET_KEY: 'automation credential encryption',
  ADMIN_EMAILS: 'admin panel + support inbox access',
  ZERNIO_API_KEY: 'social scheduling/publishing',
  NEXT_PUBLIC_SITE_URL: 'post-checkout redirect origin',
  DISCORD_WEBHOOK_URL: 'Discord signup/trial/cancel/payment-failed notifications',
};

export function validateEnv(): void {
  // Skip during `next build` — real secrets live in the deploy env, not the build env (CI builds with
  // only dummy public vars). This runs at server startup, but guard the build phase to be safe.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const isProd = process.env.NODE_ENV === 'production';
  const missingCore = CORE.filter(k => !process.env[k]?.trim());
  const missingFeature = Object.keys(FEATURE).filter(k => !process.env[k]?.trim());

  if (missingFeature.length) {
    console.warn(
      `[env] missing optional vars (those features are disabled): ` +
      missingFeature.map(k => `${k} → ${FEATURE[k]}`).join('; '),
    );
  }
  if (missingCore.length) {
    const msg = `[env] MISSING REQUIRED vars: ${missingCore.join(', ')}. The app cannot function without these.`;
    if (isProd) throw new Error(msg);
    console.error(`${msg} (continuing because NODE_ENV != production; the app will fail at runtime)`);
  }
}
