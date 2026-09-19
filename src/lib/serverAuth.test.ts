import { describe, it, expect, vi, beforeEach } from 'vitest';

// The subscriptions read result, swapped per test. The mock's query chain resolves to this.
let subResult: { data: unknown; error: unknown } = { data: [], error: null };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: vi.fn() },
    from: () => ({ select: () => ({ eq: () => Promise.resolve(subResult) }) }),
  }),
}));

import { requireSubscriber, hasActiveSubscription, isAdminEmail } from './serverAuth';
import type { User } from '@supabase/supabase-js';

const user = (email?: string): User => ({ id: 'u1', email } as User);
const req = () => new Request('http://x', { headers: { authorization: 'Bearer tok' } });

beforeEach(() => {
  subResult = { data: [], error: null };
  process.env.ADMIN_EMAILS = 'admin@x.com';
});

describe('requireSubscriber (Pro-gate — fails CLOSED for access)', () => {
  it('lets admins through with no DB check', async () => {
    expect(await requireSubscriber(req(), user('admin@x.com'))).toBeNull();
  });

  it('returns null for a subscriber with an active row', async () => {
    subResult = { data: [{ status: 'active', ends_at: null }], error: null };
    expect(await requireSubscriber(req(), user('u@x.com'))).toBeNull();
  });

  it('returns 403 subscription_required for a free user (no rows)', async () => {
    const res = (await requireSubscriber(req(), user('u@x.com')))!;
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('subscription_required');
  });

  it('fails CLOSED to 503 (never a paywall) when the read errors — a paying user sees "try again"', async () => {
    subResult = { data: null, error: { message: 'db down' } };
    const res = (await requireSubscriber(req(), user('u@x.com')))!;
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBeUndefined();
  });

  it('treats a past ends_at as hard expiry → 403', async () => {
    subResult = { data: [{ status: 'active', ends_at: '2000-01-01T00:00:00Z' }], error: null };
    expect((await requireSubscriber(req(), user('u@x.com')))!.status).toBe(403);
  });

  it('honors cancelled-but-not-yet-expired (future ends_at) as access', async () => {
    subResult = { data: [{ status: 'cancelled', ends_at: '2999-01-01T00:00:00Z' }], error: null };
    expect(await requireSubscriber(req(), user('u@x.com'))).toBeNull();
  });
});

describe('hasActiveSubscription (checkout double-charge guard — fails OPEN)', () => {
  it('true when a granting row exists', async () => {
    subResult = { data: [{ status: 'active', ends_at: null }], error: null };
    expect(await hasActiveSubscription(req(), user('u@x.com'))).toBe(true);
  });

  it('fails OPEN (false) on a read error so a new customer is never blocked from paying', async () => {
    subResult = { data: null, error: { message: 'db down' } };
    expect(await hasActiveSubscription(req(), user('u@x.com'))).toBe(false);
  });
});

describe('isAdminEmail', () => {
  it('matches case-insensitively, trims, and ignores blanks / missing env', () => {
    process.env.ADMIN_EMAILS = 'A@x.com, b@x.com';
    expect(isAdminEmail('a@x.com')).toBe(true);
    expect(isAdminEmail('c@x.com')).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail('a@x.com')).toBe(false);
  });
});
