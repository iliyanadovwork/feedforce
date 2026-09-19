import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatMoney, formatDate, sendDiscordNotification } from './discord';

describe('formatMoney', () => {
  it('formats whole amounts without decimals', () => {
    expect(formatMoney(4900, 'usd')).toBe('$49');
    expect(formatMoney(0, 'usd')).toBe('$0');
  });
  it('shows decimals for non-whole amounts', () => {
    expect(formatMoney(4999, 'usd')).toBe('$49.99');
  });
  it('handles null and other currencies', () => {
    expect(formatMoney(null, null)).toBe('$0');
    expect(formatMoney(1000, 'gbp')).toMatch(/10/);
  });
});

describe('formatDate', () => {
  it('formats unix seconds as "D Month YYYY"', () => {
    const ts = Math.floor(Date.parse('2026-06-25T12:00:00Z') / 1000);
    expect(formatDate(ts)).toBe('25 June 2026');
  });
  it('returns empty for missing input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
});

describe('sendDiscordNotification', () => {
  const original = process.env.DISCORD_WEBHOOK_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = original;
    vi.restoreAllMocks();
  });

  it('no-ops (no network call) when DISCORD_WEBHOOK_URL is unset', async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await sendDiscordNotification({ title: 't', color: 1, fields: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts one embed and drops empty-valued fields', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await sendDiscordNotification({
      title: '🚀 Test', color: 0x22c55e,
      fields: [{ name: 'Name', value: 'John' }, { name: 'Empty', value: '' }],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.embeds[0].title).toBe('🚀 Test');
    expect(body.embeds[0].fields).toHaveLength(1); // the empty one is filtered out
    expect(body.embeds[0].fields[0]).toMatchObject({ name: 'Name', value: 'John' });
  });

  it('never throws when the post fails (best-effort)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/x/y';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(sendDiscordNotification({ title: 't', color: 1, fields: [] })).resolves.toBeUndefined();
  });
});
