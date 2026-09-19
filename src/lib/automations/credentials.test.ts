import { describe, it, expect, beforeAll } from 'vitest';

// AES-GCM round-trip. Set the key BEFORE importing the module (it reads env at call time, so importing
// dynamically after setting env keeps this robust regardless of import order).
beforeAll(() => { process.env.AUTOMATION_SECRET_KEY = 'test-secret-key-for-unit-tests'; });

describe('credential encryption', () => {
  it('round-trips a secret', async () => {
    const { encryptSecret, decryptSecret } = await import('./credentials');
    const blob = encryptSecret('sk-live-12345');
    expect(blob).not.toContain('sk-live-12345');     // not stored in clear
    expect(decryptSecret(blob)).toBe('sk-live-12345');
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const { encryptSecret } = await import('./credentials');
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects a tampered blob', async () => {
    const { encryptSecret, decryptSecret } = await import('./credentials');
    const blob = encryptSecret('secret');
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
