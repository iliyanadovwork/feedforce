// Feature flags for staged rollout.
//
// NEXT_PUBLIC_ so the SAME value is readable in client components (to hide UI) and in server code /
// middleware (to hard-block API routes). NEXT_PUBLIC vars are inlined at build time, so changing the
// flag in Vercel takes effect on the next deploy — the right granularity for a launch gate.

/**
 * The Automations node-flow engine + Schedule + their AI features. Re-enabled by default (the team is
 * actively building on it). ON unless explicitly set to 'false' — set NEXT_PUBLIC_AUTOMATIONS_ENABLED=false
 * to hide it again (e.g. in production, where the unsandboxed Code node is a known risk — see the audit).
 */
export const AUTOMATIONS_ENABLED = process.env.NEXT_PUBLIC_AUTOMATIONS_ENABLED !== 'false';

/**
 * BRIA "Expand image" (generative outpaint, Posts → image card). Hidden + blocked by default — it runs
 * on a shared paid/trial key and isn't ready to expose. Set NEXT_PUBLIC_EXPAND_IMAGE_ENABLED=true to re-enable.
 */
export const EXPAND_IMAGE_ENABLED = process.env.NEXT_PUBLIC_EXPAND_IMAGE_ENABLED === 'true';
