import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// Admin affiliate-application review queue (see /admin → Applications).
//   GET → { applications: [...], pendingCount }  every application, newest first.
// Approve/reject live at ./[id]/approve and ./[id]/reject. Gated by ADMIN_EMAILS.


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const { data, error } = await supabaseAdmin()
    .from('affiliate_applications')
    .select('id,status,name,email,website,instagram_handle,tiktok_handle,youtube_handle,twitter_handle,audience_size,promotion_plan,reject_reason,created_at')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const applications = (data ?? []).map(a => ({
    id: a.id as string,
    status: a.status as 'pending' | 'approved' | 'rejected',
    name: a.name as string,
    email: a.email as string,
    website: a.website as string,
    instagramHandle: a.instagram_handle as string,
    tiktokHandle: a.tiktok_handle as string,
    youtubeHandle: a.youtube_handle as string,
    twitterHandle: a.twitter_handle as string,
    audienceSize: a.audience_size as string,
    promotionPlan: a.promotion_plan as string,
    rejectReason: a.reject_reason as string | null,
    createdAt: a.created_at as string,
  }));
  const pendingCount = applications.filter(a => a.status === 'pending').length;

  return NextResponse.json({ applications, pendingCount });
}
