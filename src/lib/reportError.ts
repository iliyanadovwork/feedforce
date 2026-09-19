// Central server-side error reporter.
//
// Today it writes a structured, greppable line to the platform logs; more importantly it is the ONE
// place to wire a real error tracker (Sentry, etc.) into later — add the capture call here and every
// call site is covered at once. The money/critical paths (billing webhooks, cron) report through this
// so a failure is never silent: alert on the `[error]` prefix, or drop in Sentry below.
//
// To enable Sentry: `npm i @sentry/nextjs`, set SENTRY_DSN, then add
//   Sentry.captureException(err, { tags: { context }, extra });
// inside reportError — nothing else changes.
export function reportError(context: string, error: unknown, extra?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
  console.error(`[error] ${context}: ${err.message}`, extra ? { ...extra, stack: err.stack } : { stack: err.stack });
}
