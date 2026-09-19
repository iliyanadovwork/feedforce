import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// Admin redeem-code management (see /admin): GET lists codes with redemption state; POST generates a
// batch. Codes grant a free month of access independent of the billing provider (see
// /api/billing/redeem). Gated by ADMIN_EMAILS.


// Unambiguous alphabet (no 0/O, 1/I/L) — codes get typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 3) s += '-';
  }
  return `FEEDFORCE-${s}`;
}

export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const { data, error } = await supabaseAdmin()
    .from('redeem_codes')
    .select('code,months,created_at,redeemed_by,redeemed_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ codes: data ?? [] });
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const body = (await req.json().catch(() => ({}))) as { count?: number; months?: number };
  const count = Math.min(50, Math.max(1, Math.round(Number(body.count) || 1)));
  const months = Math.min(12, Math.max(1, Math.round(Number(body.months) || 1)));

  const rows = Array.from({ length: count }, () => ({ code: generateCode(), months }));
  const { error } = await supabaseAdmin().from('redeem_codes').insert(rows);
  if (error) {
    // A same-code collision is astronomically unlikely (31^8 space) — surface any error as-is.
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ codes: rows.map(r => r.code) });
}
