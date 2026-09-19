import { authedFetch } from './authedFetch';

// Kick off a Lemon Squeezy checkout: ask our API for a checkout URL for the signed-in user, then send
// the browser there. Pass a variantId to choose a specific plan, or omit to use LEMONSQUEEZY_VARIANT_ID.
export async function startCheckout(variantId?: string): Promise<void> {
  const res = await authedFetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(variantId ? { variantId } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Checkout failed' })) as { error?: string; code?: string };
    // Carry the server's code (e.g. 'already_subscribed') on the error so callers can react —
    // refresh a stale plan snapshot and dismiss — rather than only surfacing the message string.
    const err = new Error(body.error || 'Checkout failed') as Error & { code?: string };
    if (body.code) err.code = body.code;
    throw err;
  }
  const { url } = await res.json();
  if (!url) throw new Error('No checkout URL returned');
  window.location.href = url;
}
