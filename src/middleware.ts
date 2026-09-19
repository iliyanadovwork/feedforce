import { NextResponse } from 'next/server';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';

// Hard-block the automations + scheduling API surface while those features are gated off for launch
// (NEXT_PUBLIC_AUTOMATIONS_ENABLED). Hiding the UI is not enough — these routes call the shared AI keys
// and the (unsandboxed) Code node, so the real boundary is here. Returns 404 so the endpoints look
// nonexistent rather than merely forbidden.
export function middleware() {
  if (AUTOMATIONS_ENABLED) return NextResponse.next();
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export const config = {
  matcher: ['/api/automations/:path*', '/api/cron/automations', '/api/schedule/:path*'],
};
