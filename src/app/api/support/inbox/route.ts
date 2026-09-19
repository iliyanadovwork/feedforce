import { NextResponse } from 'next/server';
import { requireUser, unauthorized } from '@/lib/serverAuth';
import { isAdminEmail, ensureAdminComp } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// Admin side of the live support chat. Admins are the accounts listed in the ADMIN_EMAILS env
// (comma-separated, case-insensitive — parsed once in lib/adminAuth). Users never come through
// here — they read/write their own conversation directly under RLS (and receive replies over
// realtime); this route is for reading ALL conversations, replying as 'admin', and toggling
// status, which need the service role.
//
//   GET  ?probe=1            → { admin: true }                (cheap "am I an admin?" check)
//   GET  ?count=1            → { needsReply: n }              (open convos awaiting an admin reply — nav badge)
//   GET                      → { conversations: [...] }       (newest first, with last-message preview)
//   GET  ?conversation=<id>  → { conversation, messages }     (thread — newest 500, oldest first)
//   POST { conversationId, body }   → { message }             (reply as admin; trigger bumps the convo)
//   PATCH { id, status: 'open'|'closed' } → { ok: true }

const notFound = () => NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const url = new URL(req.url);
  if (url.searchParams.get('probe') === '1') return NextResponse.json({ admin: true });

  const convoId = url.searchParams.get('conversation');
  const db = supabaseAdmin();

  // Piggyback on the badge poll every admin's browser makes on app load: make sure this admin
  // holds their permanent comp subscription row (Pro everywhere, including the DB quota layer).
  await ensureAdminComp(db, user);

  // Needs-reply count for the sidebar / admin-tab badge: open threads where the user spoke last.
  // Head-only count — no rows cross the wire, cheap enough to poll.
  if (url.searchParams.get('count') === '1') {
    const { count, error } = await db
      .from('support_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .eq('last_sender', 'user');
    if (error) return NextResponse.json({ error: 'Failed to count' }, { status: 500 });
    return NextResponse.json({ needsReply: count ?? 0 });
  }

  if (convoId) {
    // Newest 500 fetched descending, then flipped for display — a longer thread loses its OLDEST
    // messages, never the fresh end of the chat.
    const [convoRes, msgsRes] = await Promise.all([
      db.from('support_conversations').select('*').eq('id', convoId).maybeSingle(),
      db.from('support_messages')
        .select('id,sender,body,created_at')
        .eq('conversation_id', convoId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(500),
    ]);
    if (convoRes.error || msgsRes.error) {
      return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
    }
    if (!convoRes.data) return notFound();
    return NextResponse.json({ conversation: convoRes.data, messages: (msgsRes.data ?? []).reverse() });
  }

  const { data: conversations, error } = await db
    .from('support_conversations')
    .select('id,email,status,last_sender,created_at,last_message_at')
    .order('last_message_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: 'Failed to load conversations' }, { status: 500 });

  // Last-message previews in one query: newest 500 messages across these threads, first per convo.
  const ids = (conversations ?? []).map(c => c.id);
  const previews = new Map<string, string>();
  if (ids.length > 0) {
    const { data: msgs } = await db
      .from('support_messages')
      .select('conversation_id,body,created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
      .limit(500);
    for (const m of msgs ?? []) {
      if (!previews.has(m.conversation_id)) previews.set(m.conversation_id, m.body);
    }
  }

  return NextResponse.json({
    conversations: (conversations ?? []).map(c => ({ ...c, preview: previews.get(c.id) ?? '' })),
  });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { conversationId?: string; body?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const text = (body.body ?? '').trim().slice(0, 5000);
  if (!body.conversationId || !text) {
    return NextResponse.json({ error: 'conversationId and body required' }, { status: 400 });
  }

  const db = supabaseAdmin();
  // Confirm the thread exists first so a bad id is a clean 404, not an FK-violation 500.
  const { data: convo, error: convoError } = await db
    .from('support_conversations')
    .select('id')
    .eq('id', body.conversationId)
    .maybeSingle();
  if (convoError) return NextResponse.json({ error: 'Failed to send reply' }, { status: 500 });
  if (!convo) return notFound();

  const { data, error } = await db
    .from('support_messages')
    .insert({ conversation_id: convo.id, sender: 'admin', body: text })
    .select('id,sender,body,created_at')
    .single();
  if (error || !data) return NextResponse.json({ error: 'Failed to send reply' }, { status: 500 });
  return NextResponse.json({ message: data });
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { id?: string; status?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const { id, status } = body;
  if (!id || (status !== 'open' && status !== 'closed')) {
    return NextResponse.json({ error: 'id and status (open|closed) required' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from('support_conversations')
    .update({ status })
    .eq('id', id)
    .select('id');
  if (error) return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 });
  if (!data || data.length === 0) return notFound();
  return NextResponse.json({ ok: true });
}
