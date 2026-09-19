import crypto from 'crypto';

// Server-only Lemon Squeezy helpers. We talk to the REST API with plain fetch (JSON:API format) so no
// extra dependency is needed. Docs: https://docs.lemonsqueezy.com/api
// Required env (see .env.example):
//   LEMONSQUEEZY_API_KEY        — API key from Settings → API
//   LEMONSQUEEZY_STORE_ID       — numeric store id
//   LEMONSQUEEZY_WEBHOOK_SECRET — the signing secret you set when creating the webhook
//   NEXT_PUBLIC_SITE_URL        — origin used for the post-checkout redirect (e.g. http://localhost:3000)

const API = 'https://api.lemonsqueezy.com/v1';

function apiKey(): string {
  const k = process.env.LEMONSQUEEZY_API_KEY;
  if (!k) throw new Error('LEMONSQUEEZY_API_KEY is not set');
  return k;
}

function headers() {
  return {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    Authorization: `Bearer ${apiKey()}`,
  };
}

/**
 * Create a hosted checkout for `variantId`, tagged with our `userId` in custom data so the webhook can
 * map the resulting subscription back to the Supabase user. Returns the checkout URL to redirect to.
 */
export async function createCheckout(opts: {
  variantId: string;
  userId: string;
  email?: string;
  redirectUrl?: string;
}): Promise<string> {
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  if (!storeId) throw new Error('LEMONSQUEEZY_STORE_ID is not set');

  const body = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email: opts.email,
          // custom values come back on every subscription webhook under meta.custom_data
          custom: { user_id: opts.userId },
        },
        product_options: opts.redirectUrl ? { redirect_url: opts.redirectUrl } : undefined,
      },
      relationships: {
        store: { data: { type: 'stores', id: String(storeId) } },
        variant: { data: { type: 'variants', id: String(opts.variantId) } },
      },
    },
  };

  const res = await fetch(`${API}/checkouts`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Lemon Squeezy checkout failed (${res.status}): ${detail}`);
  }
  const json = await res.json();
  const url = json?.data?.attributes?.url;
  if (!url) throw new Error('Lemon Squeezy checkout response missing url');
  return url as string;
}

/**
 * Fetch a FRESH customer-portal URL for a subscription. The urls in webhook payloads are signed and
 * expire after 24h, so the value mirrored into the DB goes stale — always fetch at click time.
 */
export async function getCustomerPortalUrl(subscriptionId: string): Promise<string | null> {
  const res = await fetch(`${API}/subscriptions/${encodeURIComponent(subscriptionId)}`, { headers: headers() });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null) as { data?: { attributes?: { urls?: { customer_portal?: string } } } } | null;
  return json?.data?.attributes?.urls?.customer_portal ?? null;
}

/**
 * Verify the X-Signature header on an incoming webhook against the raw request body. Lemon Squeezy
 * signs the body with HMAC-SHA256 using your webhook secret (hex digest).
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  try {
    const a = Buffer.from(digest, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** A subscription's CURRENT state from the API — the webhook ordering guard (webhooks can arrive
 *  out of order; the row must be written from live state, never from an event snapshot). */
export async function getSubscription(id: string): Promise<NonNullable<LsWebhookPayload['data']>> {
  const res = await fetch(`${API}/subscriptions/${id}`, { headers: headers() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Lemon Squeezy subscription fetch failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: LsWebhookPayload['data'] };
  if (!json.data?.id || !json.data.attributes) throw new Error('Lemon Squeezy subscription response malformed');
  return json.data;
}

// Minimal shape of the subscription webhook payload we consume.
export interface LsWebhookPayload {
  meta?: { event_name?: string; custom_data?: { user_id?: string } };
  data?: {
    id?: string;
    attributes?: {
      store_id?: number;
      customer_id?: number;
      order_id?: number;
      product_id?: number;
      variant_id?: number;
      product_name?: string;
      variant_name?: string;
      status?: string;
      card_brand?: string;
      card_last_four?: string;
      renews_at?: string | null;
      ends_at?: string | null;
      trial_ends_at?: string | null;
      urls?: { customer_portal?: string; update_payment_method?: string };
    };
  };
}
