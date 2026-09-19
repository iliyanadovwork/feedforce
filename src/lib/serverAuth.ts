import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { User, SupabaseClient } from '@supabase/supabase-js';

// Server-side request authentication for API routes. The client attaches the
// user's Supabase access token as "Authorization: Bearer <jwt>" (see
// lib/authedFetch.ts); we verify it against Supabase Auth before letting the
// route spend money on external APIs.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
// Secret key preferred (works even if anon key is rotated); anon key verifies JWTs fine too.
const key = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Reuse a single stateless client across requests instead of allocating one per call. getUser(token)
// takes the token per-call and we keep no session, so one shared instance is safe and avoids GC churn on
// the hot path of every authenticated API route.
let cachedClient: SupabaseClient | null = null;
function authClient(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return cachedClient;
}

export async function requireUser(req: Request): Promise<User | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !url || !key) return null;
  try {
    const { data, error } = await authClient().auth.getUser(token);
    if (error || !data.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Single source of truth for the admin allowlist: ADMIN_EMAILS, comma-separated, case-insensitive.
// No env var set → nobody is admin, so admin surfaces stay inert until explicitly configured.
// Lives here (not lib/adminAuth) because requireSubscriber below needs it and adminAuth imports
// from this module — adminAuth re-exports it, so existing imports keep working.
export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

// A subscription row grants access while active/on-trial, or cancelled but not yet past its
// paid-through date; a set ends_at in the past is a hard expiry. ANY granting row counts — the
// same predicate as has_active_subscription() in supabase/free_tier.sql and grantsAccess() in
// useSubscription. Exported so every OTHER server-side consumer (e.g. the redeem no-stacking
// check) uses THIS implementation instead of re-deriving it — keep the synced copies at three.
export function rowGrantsAccess(s: { status: string; ends_at: string | null }): boolean {
  if (s.ends_at && new Date(s.ends_at).getTime() <= Date.now()) return false;
  if (s.status === 'active' || s.status === 'on_trial') return true;
  return s.status === 'cancelled' && !!s.ends_at;
}

// Does this user hold ANY granting subscription row? The one query + predicate behind both the
// Pro-gate (requireSubscriber) and its inverse (the checkout double-charge guard), so the rule
// lives in exactly one place. Runs AS THE CALLER (their bearer token + owner-read RLS), so it works
// identically under the secret or anon key. Returns 'error' when the read itself fails, letting
// each caller pick its own safe default rather than baking one in here.
async function readGrantsAccess(req: Request, user: User): Promise<boolean | 'error'> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  try {
    // Per-call client so the caller's JWT rides the request; requireUser already verified the
    // token, so RLS resolves auth.uid() to this user.
    const caller = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await caller
      .from('subscriptions')
      .select('status, ends_at')
      .eq('user_id', user.id);
    if (error) {
      console.error('subscription read failed', error.message);
      return 'error';
    }
    return (data ?? []).some(rowGrantsAccess);
  } catch (e) {
    console.error('subscription read threw', e);
    return 'error';
  }
}

// Gate for Pro-only routes (FREE_TIER_PLAN.md). Returns null for subscribers, a 403 with code
// subscription_required for free users (the client maps it to the upgrade prompt), and a 503 for
// infrastructure failures — a paying user must see "try again", never a paywall, when the check
// itself breaks (fails CLOSED for access).
export async function requireSubscriber(req: Request, user: User): Promise<NextResponse | null> {
  // Admin accounts ride free (FREE_TIER_PLAN.md) — bypass before any DB round-trip, so admins
  // keep every Pro feature even before their comp subscription row self-provisions.
  if (isAdminEmail(user.email)) return null;
  const grants = await readGrantsAccess(req, user);
  if (grants === 'error') return subscriptionCheckFailed();
  return grants ? null : subscriptionRequired();
}

// True only when we CONFIRM a granting subscription — for the checkout double-charge guard, which
// blocks a second subscription for an already-subscribed user. Fails OPEN: an errored read returns
// false so a subscriptions-read outage never blocks a legitimate NEW customer from paying (a rare
// duplicate is the lesser evil). Admins hold a comp row, so they read true and are kept out of paid
// checkout — correct, since they already have access.
export async function hasActiveSubscription(req: Request, user: User): Promise<boolean> {
  return (await readGrantsAccess(req, user)) === true;
}

// 403 for signed-in free users hitting a Pro-only route. The client maps this
// code to the upgrade prompt (see FREE_TIER_PLAN.md).
export function subscriptionRequired(): NextResponse {
  return NextResponse.json({ error: 'Subscription required', code: 'subscription_required' }, { status: 403 });
}

// 503 when the subscription check itself failed — deliberately NOT the
// subscription_required code, so the client never shows a paywall for an outage.
function subscriptionCheckFailed(): NextResponse {
  return NextResponse.json({ error: 'Could not verify your subscription — try again.' }, { status: 503 });
}
