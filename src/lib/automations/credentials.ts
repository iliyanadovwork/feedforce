import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// Credential store for automation nodes. Secrets are encrypted at rest with AES-256-GCM and only ever
// decrypted server-side, inside the runner (§9/§11). The browser only ever sees { id, label, kind } —
// the secret column is never selected client-side (RLS) and never returned by these helpers except to
// the node runtime via getCredentialSecret.

const TABLE = 'automation_credentials';

// 32-byte key derived from the server secret (accepts any-length env value). Distinct from Supabase keys
// so rotating one doesn't expose the other.
function key(): Buffer {
  const secret = process.env.AUTOMATION_SECRET_KEY || process.env.SUPABASE_SECRET_KEY || '';
  if (!secret) throw new Error('AUTOMATION_SECRET_KEY (or SUPABASE_SECRET_KEY) must be set to use credentials');
  return createHash('sha256').update(secret).digest();
}

/** Encrypt → base64(iv(12) | authTag(16) | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Reverse of encryptSecret. Throws if the blob is malformed or the key/tag don't match. */
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export interface CredentialMeta { id: string; label: string; kind: string; created_at?: string }

/** Store an encrypted secret for a user. Returns only the non-secret metadata. */
export async function storeCredential(userId: string, label: string, kind: string, secret: string): Promise<CredentialMeta> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from(TABLE)
    .insert({ user_id: userId, label, kind, secret_encrypted: encryptSecret(secret) })
    .select('id,label,kind,created_at')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Failed to store credential');
  return data as CredentialMeta;
}

/** List a user's credentials WITHOUT secrets. */
export async function listCredentials(userId: string): Promise<CredentialMeta[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from(TABLE)
    .select('id,label,kind,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CredentialMeta[];
}

/** Decrypt a single credential's secret for the runtime. Ownership-scoped; null if not found. */
export async function getCredentialSecret(userId: string, id: string): Promise<string | null> {
  const db = supabaseAdmin();
  const { data } = await db.from(TABLE).select('secret_encrypted').eq('id', id).eq('user_id', userId).maybeSingle();
  const blob = (data as { secret_encrypted?: string } | null)?.secret_encrypted;
  if (!blob) return null;
  try { return decryptSecret(blob); } catch { return null; }
}
