import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// Fixed-window rate limiter, two layers:
//   1. per-process window (free, instant) — catches bursts hitting the same instance;
//   2. shared Postgres counter (atomic upsert RPC, see production/supabase/rate_limits.sql) — holds the
//      limit across serverless instances, where layer 1 alone can be bypassed by parallel requests.
// Infra failures fail OPEN on layer 2 (a Supabase blip must not 429 every user), but layer 1 still
// applies — abuse never gets a free pass on the instance it's hammering.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

function localLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

export async function rateLimit(key: string, limit: number, windowMs = 60_000): Promise<boolean> {
  if (!localLimit(key, limit, windowMs)) return false;
  try {
    const { data, error } = await supabaseAdmin().rpc('rate_limit_hit', { p_key: key, p_limit: limit, p_window_ms: windowMs });
    if (error) return true; // RPC not migrated yet / infra hiccup — layer 1 already passed
    return data !== false;
  } catch {
    return true;
  }
}

export function tooManyRequests(): NextResponse {
  return NextResponse.json({ error: 'Too many requests — slow down.' }, { status: 429 });
}
