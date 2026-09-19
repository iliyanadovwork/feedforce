import { supabaseAdmin } from '@/lib/supabaseAdmin';

// ── Creator-rewards post ledger ───────────────────────────────────────────────────────────────────
// Right after Zernio accepts a reel, the schedule routes record it in `rewards_posts` so the rewards
// cron can attribute its views to the poster (service-role writes only; see the creator_rewards
// migration). Shared by the single-post and bulk schedule routes (mirrors lib/scheduleLedger).

// Best-effort: the publish already succeeded, so a ledger hiccup must NOT fail the request — and the
// table may not exist in prod yet (feature rolling out), which must not throw either. Upsert-ignore
// on the post id because Zernio's idempotent resends (x-request-id) return the ORIGINAL post id, and
// re-recording it would just churn the row.
export async function recordRewardsPost(userId: string, zernioPostId: string, zernioAccountId: string, stickerEnabled: boolean) {
  try {
    const db = supabaseAdmin();
    // The sticker flag is client-supplied: only an ENROLLED user gets a payable sticker row — an
    // API caller must not mint retroactively-payable history while unenrolled. Enrollment unknown
    // (read error) fails closed to sticker-off; the row itself is still recorded for the ledger.
    let sticker = stickerEnabled;
    if (sticker) {
      const { data, error } = await db.from('rewards_enrollments').select('user_id').eq('user_id', userId).maybeSingle();
      if (error || !data) {
        sticker = false;
        console.warn('[rewardsPosts] sticker requested by unenrolled user, recording without sticker:', userId);
      }
    }
    const { error } = await db.from('rewards_posts').upsert({
      user_id: userId,
      zernio_post_id: zernioPostId,
      zernio_account_id: zernioAccountId,
      sticker_enabled: sticker,
    }, { onConflict: 'zernio_post_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[rewardsPosts] recordRewardsPost failed:', e instanceof Error ? e.message : e);
  }
}
