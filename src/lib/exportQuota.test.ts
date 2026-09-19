import { describe, it, expect, vi, beforeEach } from 'vitest';

// consumeExport IS the free-tier export gate (3/month, FREE_TIER_PLAN.md): the render happens
// client-side, so if this wrapper drifts (e.g. an RPC error starts resolving instead of throwing),
// free users get unlimited exports silently. These tests pin the gate's exact semantics:
// pro bypass, allowed/exhausted mapping, and FAIL-CLOSED behavior on every failure shape.

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
import { supabase } from '@/lib/supabase';
import { consumeExport, fetchExportQuota, ExportBlockedError, EXPORTS_EXHAUSTED_REASON } from './exportQuota';

const rpc = vi.mocked(supabase.rpc);
// supabase-js never rejects on transport failure — postgrest-js catches fetch errors and resolves
// an error-shaped { data: null, error } response, so that's the canonical "network down" fixture.
const rpcResolves = (data: unknown, error: unknown = null) =>
  rpc.mockResolvedValue({ data, error } as never);

// Braces matter: vitest 4 registers a hook's RETURN VALUE as a cleanup function, and mockReset()
// returns the chainable mock — `() => rpc.mockReset()` would make the runner CALL rpc() at test
// teardown, executing whatever implementation the test installed (throwing impls fail the test).
beforeEach(() => { rpc.mockReset(); });

describe('consumeExport — the free-tier export gate', () => {
  it('pro plan: returns null (unlimited) WITHOUT touching the RPC — pro exports must not depend on it being reachable', async () => {
    // Teeth: if the pro path ever calls the RPC, this throws and the resolves-assertion fails.
    // (Sync throw, not mockRejectedValue — vitest 4 flags a never-awaited rejected mock promise
    // as an unhandled rejection; same artifact noted in http.test.ts.)
    rpc.mockImplementation(() => { throw new Error('RPC unreachable'); });
    await expect(consumeExport('pro', 'reel:entry-123')).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('free + allowed: charges the key via consume_export (p_key passed verbatim, reel:<entryId> format) and returns remaining', async () => {
    rpcResolves({ allowed: true, unlimited: false, remaining: 2 });
    await expect(consumeExport('free', 'reel:entry-123')).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('consume_export', { p_key: 'reel:entry-123' });
  });

  it('free + allowed with 0 remaining (last export this month): returns 0, does not block', async () => {
    rpcResolves({ allowed: true, unlimited: false, remaining: 0 });
    await expect(consumeExport('free', 'carousel:tpl-9')).resolves.toBe(0);
  });

  it('free + exhausted: throws ExportBlockedError (the guard maps this to the upgrade modal)', async () => {
    rpcResolves({ allowed: false, unlimited: false, remaining: 0 });
    await expect(consumeExport('free', 'reel:entry-123')).rejects.toBeInstanceOf(ExportBlockedError);
  });

  it('server says unlimited: null wins BEFORE the allowed check (server truth beats a stale client plan)', async () => {
    // e.g. the client still thinks "free" but the DB row is pro — the RPC's unlimited flag decides.
    rpcResolves({ allowed: false, unlimited: true, remaining: null });
    await expect(consumeExport('free', 'reel:entry-123')).resolves.toBeNull();
  });

  it('FAIL CLOSED on an error-shaped response (incl. network failure): throws a plain Error, exactly one attempt, no retry', async () => {
    rpcResolves(null, { message: 'FetchError: network down', code: '' });
    const err = await consumeExport('free', 'reel:entry-123').then(
      () => { throw new Error('resolved — the quota gate failed OPEN'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // NOT the exhausted flavor — the guard shows "try again", not the upgrade modal:
    expect(err).not.toBeInstanceOf(ExportBlockedError);
    expect((err as Error).message).toBe('Could not verify your export quota — try again.');
    expect(rpc).toHaveBeenCalledTimes(1); // no retry/dedupe in the wrapper; dedupe lives in the RPC's per-key ledger
  });

  it('a rejecting RPC promise propagates (never resolves) — still fail-closed at every call site', async () => {
    // supabase-js shouldn't reject, but if it ever does, the wrapper must not swallow it into success.
    // Hand-rolled rejected promise with a pre-attached no-op catch so vitest 4's unhandled-rejection
    // tracker stays quiet (mockRejectedValue trips it — same artifact noted in http.test.ts).
    const boom = new Error('unexpected transport rejection');
    const rejected = Promise.reject(boom);
    rejected.catch(() => {});
    rpc.mockImplementation(() => rejected as never);
    await expect(consumeExport('free', 'reel:entry-123')).rejects.toBe(boom);
  });

  it('null RPC payload (data null, no error): fails CLOSED as a transient error — not a raw TypeError', async () => {
    // A null payload = unreadable verdict. Blocks the export (fail-closed) but shows the friendly
    // "try again" copy, NOT a raw TypeError (the old behavior) and NOT the upgrade modal.
    rpcResolves(null, null);
    const err = await consumeExport('free', 'reel:entry-123').then(
      () => { throw new Error('resolved — the quota gate failed OPEN'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ExportBlockedError);
    expect((err as Error).message).toBe('Could not verify your export quota — try again.');
  });

  it('malformed response (object missing allowed/unlimited): transient error, NOT the upgrade modal', async () => {
    // A garbage object is an unreadable verdict, not a genuine "exhausted" — block (fail-closed) but via
    // the transient flash, so we never wrongly prompt a paying-capable user to upgrade (the old behavior).
    rpcResolves({});
    const err = await consumeExport('free', 'reel:entry-123').then(
      () => { throw new Error('resolved — the quota gate failed OPEN'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExportBlockedError);
    expect((err as Error).message).toBe('Could not verify your export quota — try again.');
  });

  it('user-facing exhausted copy matches the 3/month free cap', () => {
    expect(EXPORTS_EXHAUSTED_REASON).toMatch(/3 free exports/);
  });
});

describe('fetchExportQuota — read-only "N left" chip (never consumes)', () => {
  it('happy path: calls the export_quota RPC with no args and passes the status through', async () => {
    rpcResolves({ unlimited: false, cap: 3, remaining: 1 });
    await expect(fetchExportQuota()).resolves.toEqual({ unlimited: false, cap: 3, remaining: 1 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('export_quota');
  });

  it('unlimited (pro) status passes through untouched', async () => {
    rpcResolves({ unlimited: true, cap: null, remaining: null });
    await expect(fetchExportQuota()).resolves.toEqual({ unlimited: true, cap: null, remaining: null });
  });

  it('returns null on an error-shaped response (chip hides; consume path still enforces)', async () => {
    rpcResolves(null, { message: 'FetchError: network down' });
    await expect(fetchExportQuota()).resolves.toBeNull();
  });

  it('returns null on empty data with no error', async () => {
    rpcResolves(null, null);
    await expect(fetchExportQuota()).resolves.toBeNull();
  });
});
