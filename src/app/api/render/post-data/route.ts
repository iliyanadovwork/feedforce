import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyRenderToken } from '@/lib/renderToken';

export const runtime = 'nodejs';

// Data feed for the headless render page (/render/post/[postId]) — token-gated (short-lived HMAC,
// see lib/renderToken.ts) because the cron's headless browser has no user session. Returns the
// generated post's slides plus the owner's brand logo and custom fonts, so the canvas draws exactly
// what the in-app renderer would.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const postId = url.searchParams.get('postId') ?? '';
  const exp = Number(url.searchParams.get('exp') ?? '');
  const token = url.searchParams.get('token') ?? '';
  if (!verifyRenderToken(postId, exp, token)) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });

  const db = supabaseAdmin();
  const { data: post } = await db.from('template_editor_posts').select('id,user_id').eq('id', postId).maybeSingle();
  if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });

  const { data: slides, error } = await db
    .from('template_editor_post_slides').select('*').eq('post_id', postId).order('position', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Brand assets so slides referencing them render identically (logo slots, custom fonts).
  let logoSrc = '';
  let fonts: Array<{ id: string; label: string; url: string }> = [];
  const { data: kit } = await db.from('brand_kit').select('id').eq('user_id', post.user_id).maybeSingle();
  if (kit?.id) {
    const [logos, fontRows] = await Promise.all([
      db.from('brand_kit_logos').select('url').eq('brand_kit_id', kit.id).order('position', { ascending: true }).limit(1),
      db.from('brand_kit_fonts').select('id,label,url').eq('brand_kit_id', kit.id),
    ]);
    logoSrc = ((logos.data?.[0] as { url?: string } | undefined)?.url) ?? '';
    fonts = (fontRows.data ?? []) as Array<{ id: string; label: string; url: string }>;
  }

  return NextResponse.json({ slides: slides ?? [], logoSrc, fonts });
}
