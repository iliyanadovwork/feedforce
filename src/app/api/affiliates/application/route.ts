import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireUser, unauthorized } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// Applicant-facing affiliate application (see /affiliates/apply).
//   GET  → { application: null | {...} }  the caller's own application, if any
//   POST { name, website, instagramHandle, tiktokHandle, youtubeHandle, twitterHandle, audienceSize,
//          promotionPlan } → submit one (RLS enforces one per account; a repeat submit 409s).
// An admin later reviews it at /admin → Applications and approves/rejects
// (/api/admin/affiliate-applications).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Per-call client carrying the caller's own JWT, so RLS resolves auth.uid() to them — same pattern as
// readGrantsAccess in lib/serverAuth.ts. No service-role key needed: the owner-read/owner-insert
// policies on affiliate_applications already permit exactly what this route does.
function callerClient(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

interface ApplicationRow {
  status: 'pending' | 'approved' | 'rejected';
  name: string;
  website: string;
  instagram_handle: string;
  tiktok_handle: string;
  youtube_handle: string;
  twitter_handle: string;
  audience_size: string;
  promotion_plan: string;
  reject_reason: string | null;
  created_at: string;
}

function toClient(a: ApplicationRow) {
  return {
    status: a.status,
    name: a.name,
    website: a.website,
    instagramHandle: a.instagram_handle,
    tiktokHandle: a.tiktok_handle,
    youtubeHandle: a.youtube_handle,
    twitterHandle: a.twitter_handle,
    audienceSize: a.audience_size,
    promotionPlan: a.promotion_plan,
    rejectReason: a.reject_reason,
    createdAt: a.created_at,
  };
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { data, error } = await callerClient(req)
    .from('affiliate_applications')
    .select('status,name,website,instagram_handle,tiktok_handle,youtube_handle,twitter_handle,audience_size,promotion_plan,reject_reason,created_at')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ application: data ? toClient(data as ApplicationRow) : null });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  // A legit applicant submits once (repeats 409 anyway); the cap just stops scripted spam churn.
  if (!(await rateLimit('affiliates:apply:' + user.id, 3))) return tooManyRequests();

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Bounded coercion: these are stored verbatim and rendered in the admin review UI, so cap every
  // free-text field (generous for honest input, a hard stop for megabyte payloads).
  const field = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  const name = field(body.name, 200);
  const website = field(body.website, 200);
  const instagramHandle = field(body.instagramHandle, 200);
  const tiktokHandle = field(body.tiktokHandle, 200);
  const youtubeHandle = field(body.youtubeHandle, 200);
  const twitterHandle = field(body.twitterHandle, 200);
  const audienceSize = field(body.audienceSize, 200);
  const promotionPlan = field(body.promotionPlan, 5000);

  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  if (!website && !instagramHandle && !tiktokHandle && !youtubeHandle && !twitterHandle) {
    return NextResponse.json({ error: 'Add your website or at least one social handle.' }, { status: 400 });
  }

  const { error } = await callerClient(req).from('affiliate_applications').insert({
    user_id: user.id,
    email: user.email ?? '',
    name, website,
    instagram_handle: instagramHandle,
    tiktok_handle: tiktokHandle,
    youtube_handle: youtubeHandle,
    twitter_handle: twitterHandle,
    audience_size: audienceSize,
    promotion_plan: promotionPlan,
  });
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: "You've already applied." }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
