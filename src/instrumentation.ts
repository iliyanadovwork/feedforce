// Next.js runtime boot hook — register() runs once per server-instance start (not during `next build`).
// Validate the environment fail-fast so a deploy with a missing/typo'd core secret surfaces immediately
// in the logs instead of booting green and 500-ing per request.
export async function register() {
  // Only the Node.js server runtime reads these secrets; the edge runtime (middleware) doesn't.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('@/lib/env');
    validateEnv();
  }
}
