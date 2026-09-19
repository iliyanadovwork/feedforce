import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Service-role Supabase client for trusted server contexts (e.g. the Lemon Squeezy webhook) that must
// write rows on behalf of a user with NO end-user JWT. This key bypasses RLS — only ever import it
// from server-only code (API routes), never from anything shipped to the browser.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? '';

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!url || !serviceKey) {
    throw new Error('supabaseAdmin: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  }
  if (!cached) {
    cached = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return cached;
}
