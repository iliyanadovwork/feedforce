import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ZernioAccount } from '@/lib/zernio';

// Regression lock for the accountId ownership guard in publishFlowPosts (the automations publish
// engine). A Post node's accountId comes from client-authored flow config, so without this guard a
// user could point a Post node at ANOTHER user's accountId and publish to their Instagram — the same
// IDOR class fixed on /api/schedule/post (create) and /api/schedule/post/[id] (edit/cancel). The guard
// runs BEFORE any rendering, so these tests pin it without a browser: a foreign account fails the node
// and never creates a post, a Zernio hiccup fails closed (nothing published), and an owned account
// clears the guard.

const state = vi.hoisted(() => ({ profileId: 'zprofile-1' as string | null }));

const zern = vi.hoisted(() => ({
  listAccounts: vi.fn<(profileId?: string) => Promise<ZernioAccount[]>>(),
  createInstagramPost: vi.fn(),
}));
vi.mock('@/lib/zernio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/zernio')>();
  return { ...actual, listAccounts: zern.listAccounts, createInstagramPost: zern.createInstagramPost };
});

// Chainable supabaseAdmin: only the social_profiles read matters before the guard; maybeSingle yields
// the configured profile id (or null). Any incidental write chains resolve inertly.
vi.mock('@/lib/supabaseAdmin', () => {
  interface Chain {
    select: (...a: unknown[]) => Chain; eq: (...a: unknown[]) => Chain;
    like: (...a: unknown[]) => Chain; in: (...a: unknown[]) => Chain;
    delete: (...a: unknown[]) => Chain; insert: (...a: unknown[]) => Chain;
    maybeSingle: () => Promise<{ data: unknown; error: null }>;
    then: (ok: (v: { data: unknown[]; error: null }) => unknown, err?: (e: unknown) => unknown) => Promise<unknown>;
  }
  const chain: Chain = {
    select: () => chain, eq: () => chain, like: () => chain, in: () => chain, delete: () => chain, insert: () => chain,
    maybeSingle: async () => ({ data: state.profileId ? { zernio_profile_id: state.profileId } : null, error: null }),
    then: (ok) => Promise.resolve({ data: [] as unknown[], error: null }).then(ok),
  };
  const admin = {
    from: () => chain,
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
  };
  return { supabaseAdmin: () => admin };
});

import { publishFlowPosts } from '@/lib/automations/serverPublish';
import { ZernioError } from '@/lib/zernio';

const MY_ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FOREIGN_ACCOUNT = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function account(id: string, profileId = 'zprofile-1'): ZernioAccount {
  // Object-shaped profileId, matching the live API (populated {_id, name}); a string-only mock shape is
  // how the 2026-07-19 empty-ownedAccountIds outage passed CI. accountProfileId() must normalize this.
  return { _id: id, platform: 'instagram', profileId: { _id: profileId, name: 'u@test.dev' }, username: 'u', displayName: 'U', isActive: true };
}

function flow(postCfg: Record<string, unknown>, withTemplateEdge = true) {
  const nodes = [
    { id: 'tpl1', type: 'template', config: {} },
    { id: 'post1', type: 'post', config: postCfg },
  ];
  const edges = withTemplateEdge ? [{ from: { node: 'tpl1', port: 'out' }, to: { node: 'post1', port: 'in' } }] : [];
  return { id: 'flow1', user_id: 'userA', graph: { nodes, edges } } as Parameters<typeof publishFlowPosts>[0];
}

const noBrowser = (async () => { throw new Error('getBrowser should not be reached'); }) as unknown as Parameters<typeof publishFlowPosts>[3];

beforeEach(() => {
  zern.listAccounts.mockReset();
  zern.createInstagramPost.mockReset();
  state.profileId = 'zprofile-1';
  zern.listAccounts.mockResolvedValue([account(MY_ACCOUNT)]);
});

describe('publishFlowPosts — accountId ownership guard', () => {
  it('foreign accountId → node fails and createInstagramPost is NEVER called (blocked before any render)', async () => {
    const res = await publishFlowPosts(flow({ accountId: FOREIGN_ACCOUNT }), {}, 'http://o', noBrowser);
    expect(res.statusByNode.post1).toBe('failed');
    expect(res.errors.some(e => /not connected/i.test(e))).toBe(true);
    expect(res.published).toBe(0);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
    expect(zern.listAccounts).toHaveBeenCalledExactlyOnceWith('zprofile-1');
  });

  it('account that exists but under a DIFFERENT profile → still blocked (profileId pin, not just _id match)', async () => {
    zern.listAccounts.mockResolvedValue([account(FOREIGN_ACCOUNT, 'someone-elses-profile')]);
    const res = await publishFlowPosts(flow({ accountId: FOREIGN_ACCOUNT }), {}, 'http://o', noBrowser);
    expect(res.statusByNode.post1).toBe('failed');
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('listAccounts throws (Zernio blip) → FAIL CLOSED: every Post node fails, nothing is published', async () => {
    zern.listAccounts.mockRejectedValue(new ZernioError('upstream down', 503));
    const res = await publishFlowPosts(flow({ accountId: MY_ACCOUNT }), {}, 'http://o', noBrowser);
    expect(res.statusByNode.post1).toBe('failed');
    expect(res.errors.some(e => /verify account ownership/i.test(e))).toBe(true);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('no connected profile (social_profiles empty) → node fails, listAccounts never called, no create', async () => {
    state.profileId = null;
    const res = await publishFlowPosts(flow({ accountId: MY_ACCOUNT }), {}, 'http://o', noBrowser);
    expect(res.statusByNode.post1).toBe('failed');
    expect(zern.listAccounts).not.toHaveBeenCalled();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('owned accountId → clears the guard (no ownership failure); skips cleanly with no template edge', async () => {
    // No template edge → the node is skipped at the tpl lookup that immediately FOLLOWS the guard,
    // so reaching that skip (rather than an ownership failure) proves the owned account passed the guard.
    const res = await publishFlowPosts(flow({ accountId: MY_ACCOUNT }, false), {}, 'http://o', noBrowser);
    expect(res.errors.some(e => /not connected/i.test(e))).toBe(false);
    expect(res.statusByNode.post1).toBeUndefined();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
    expect(zern.listAccounts).toHaveBeenCalledExactlyOnceWith('zprofile-1');
  });

  it('unconfigured Post node (no accountId) → skipped silently, no ownership failure', async () => {
    const res = await publishFlowPosts(flow({}), {}, 'http://o', noBrowser);
    expect(res.statusByNode.post1).toBeUndefined();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });
});
