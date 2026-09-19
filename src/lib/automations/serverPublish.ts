import type { Browser } from 'puppeteer-core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { signRenderToken } from '@/lib/renderToken';
import { createInstagramPost, listAccounts, accountProfileId, type IgContentType, type MediaItem } from '@/lib/zernio';
import { extractPlaceholders, collectStrings } from './mapping';
import { wallTimeToUtcMs } from './cron';
import type { Graph, RunOutputs } from './types';

// Server-side publish step for scheduled (cron) automation runs — the headless twin of the browser's
// publishPostNodes. The canvas only exists in a browser, so a headless Chromium loads the hidden
// /render/post/[id] page (token-gated) and screenshots each slide; the PNGs are uploaded to the
// public bucket, ledgered for cleanup (scheduled_render_media), handed to Zernio (which fetches the
// URL at publish time and hosts its own copy), and the ephemeral generated posts are deleted.

const RENDER_W = 410;               // the render page lays slides out at preview width…
const OUTPUT_W = 1080;              // …and deviceScaleFactor upscales screenshots to full size
const MAX_CAROUSEL = 10;            // Instagram carousel cap
const PAGE_TIMEOUT_MS = 60_000;

/** Launch the bundled serverless Chromium (Vercel) or a local Chrome via CHROME_EXECUTABLE_PATH (dev). */
export async function launchRenderBrowser(): Promise<Browser> {
  const puppeteer = (await import('puppeteer-core')).default;
  const local = process.env.CHROME_EXECUTABLE_PATH;
  if (local) return puppeteer.launch({ executablePath: local, headless: true });
  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
}

async function ledger(db: SupabaseClient, userId: string, postId: string, paths: string[], expiresAtMs: number): Promise<void> {
  if (!paths.length) return;
  await db.from('scheduled_render_media').insert(paths.map(path => ({
    user_id: userId, post_id: postId, bucket: 'post-images', path, expires_at: new Date(expiresAtMs).toISOString(),
  })));
}

async function deleteRenders(db: SupabaseClient, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await db.storage.from('post-images').remove(paths);
  await db.from('scheduled_render_media').delete().in('path', paths);
}

/** Screenshot every slide of a generated post via the hidden render page → upload → public URLs. */
async function renderPostToStorage(
  db: SupabaseClient, browser: Browser, origin: string, userId: string, postId: string,
): Promise<Array<{ url: string; path: string }>> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: RENDER_W + 32, height: 1400, deviceScaleFactor: OUTPUT_W / RENDER_W });
    const exp = Date.now() + 10 * 60_000;
    const token = signRenderToken(postId, exp);
    await page.goto(`${origin}/render/post/${postId}?exp=${exp}&token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle0', timeout: PAGE_TIMEOUT_MS });
    await page.waitForSelector('#render-ready', { timeout: PAGE_TIMEOUT_MS });
    const els = await page.$$('[data-render-slide]');
    const out: Array<{ url: string; path: string }> = [];
    const stamp = Date.now();
    for (let i = 0; i < els.length; i++) {
      const shot = await els[i].screenshot({ type: 'png' });
      const path = `${userId}/_renders/auto_${postId}_${stamp}_${i}.png`;
      const { error } = await db.storage.from('post-images').upload(path, Buffer.from(shot), { contentType: 'image/png' });
      if (error) throw new Error(`upload failed: ${error.message}`);
      out.push({ url: db.storage.from('post-images').getPublicUrl(path).data.publicUrl, path });
    }
    return out;
  } finally {
    await page.close().catch(() => { /* browser reused across posts */ });
  }
}

export interface PublishResult {
  published: number;
  errors: string[];
  /** Per Post-node outcome, for the canvas badges (manual runs render these client-side). */
  statusByNode: Record<string, 'posted' | 'scheduled' | 'failed'>;
}

/** Placeholders present in a carousel template's slides but absent from the flow's bindings — a post
 *  must not go out with literal {placeholder} text baked into the images. */
async function unmappedPlaceholders(db: SupabaseClient, templateNode: { config?: Record<string, unknown> }): Promise<string[]> {
  const [kind, templateId] = String(templateNode.config?.templateId ?? '').split(':');
  if (kind !== 'carousel' || !templateId) return [];
  // NB: `settings` is a CLIENT-side aggregate (rowToSlide) — the table stores individual columns.
  // {placeholders} live in headline/subheadline and the text_boxes JSONB ([{ text }...]).
  const { data: slides, error } = await db.from('template_editor_slides')
    .select('headline,subheadline,text_boxes').eq('template_id', templateId);
  if (error) throw new Error(`placeholder check failed: ${error.message}`); // fail LOUD — a silent [] would neuter the guard
  const found = new Set<string>();
  for (const s of (slides ?? []) as Array<{ headline?: string; subheadline?: string; text_boxes?: unknown }>) {
    for (const text of [s.headline ?? '', s.subheadline ?? '', ...collectStrings(s.text_boxes)]) {
      for (const ph of extractPlaceholders(text)) found.add(ph);
    }
  }
  const bindings = (templateNode.config?.bindings && typeof templateNode.config.bindings === 'object'
    ? templateNode.config.bindings : {}) as Record<string, string>;
  return [...found].filter(ph => !bindings[ph] || !String(bindings[ph]).trim());
}

/** Publish every Post node of a just-run flow: render its generated post(s), send to Zernio per the
 *  node's config, ledger the renders for cleanup, and delete the ephemeral generated posts. */
export async function publishFlowPosts(
  flow: { id: string; user_id: string; graph: Graph },
  outputs: Record<string, RunOutputs>,
  origin: string,
  getBrowser: () => Promise<Browser>,
  opts: {
    /** Timezone for OFFSET-LESS scheduledFor strings on Post nodes with no stored cfg.tz — configs
     *  saved before tz-capture existed. Manual runs pass the browser's zone (restoring the old
     *  client-side interpretation); cron runs have no browser and keep the server default. */
    fallbackTz?: string;
  } = {},
): Promise<PublishResult> {
  const db = supabaseAdmin();
  const errors: string[] = [];
  const statusByNode: PublishResult['statusByNode'] = {};
  let published = 0;

  const nodes = flow.graph?.nodes ?? [];
  const edges = flow.graph?.edges ?? [];
  const postIdsOf = (nodeId: string) =>
    ((outputs[nodeId]?.out ?? []) as Array<{ json?: { postId?: unknown } }>)
      .map(it => it?.json?.postId).filter((x): x is string => typeof x === 'string');
  const allGenerated = nodes.filter(n => n.type === 'template').flatMap(n => postIdsOf(n.id));

  try {
    const postNodes = nodes.filter(n => n.type === 'post');
    if (!postNodes.length) return { published, errors, statusByNode };

    // The flow's owner must have a Zernio profile (created when they connected an account).
    const { data: sp } = await db.from('social_profiles').select('zernio_profile_id').eq('user_id', flow.user_id).maybeSingle();
    const profileId = (sp as { zernio_profile_id?: string } | null)?.zernio_profile_id;

    // Ownership guard (mirrors /api/schedule/post): a Post node's accountId comes from client-authored
    // flow config, so without this a user could point a Post node at ANOTHER user's accountId and publish
    // to their Instagram (same IDOR class). listAccounts is profile-scoped server-side; an account in the
    // owner's list AND under this profile is authoritatively theirs. Fetched once; if it can't be verified
    // (Zernio blip), block every Post node this run — fail closed, never publish an unverified account.
    let ownedAccountIds: Set<string> | null = null;
    if (profileId) {
      try {
        // accountProfileId() normalizes the POPULATED (object-shaped) profileId the live API returns; a
        // direct === string comparison yielded an EMPTY set and failed every publish (incident 2026-07-19).
        ownedAccountIds = new Set((await listAccounts(profileId)).filter(a => accountProfileId(a) === profileId).map(a => a._id));
      } catch {
        for (const pn of postNodes) { errors.push('Could not verify account ownership — not publishing this run.'); statusByNode[pn.id] = 'failed'; }
        return { published, errors, statusByNode };
      }
    }

    for (const pn of postNodes) {
      const cfg = (pn.config ?? {}) as Record<string, unknown>;
      const accountId = typeof cfg.accountId === 'string' ? cfg.accountId : '';
      if (!accountId) continue; // unconfigured Post node — skip silently, like the browser path
      if (!profileId) { errors.push('No connected social profile'); statusByNode[pn.id] = 'failed'; continue; }
      if (!ownedAccountIds?.has(accountId)) { errors.push('This Post node targets an account that is not connected to your workspace.'); statusByNode[pn.id] = 'failed'; continue; }
      const tpl = edges.filter(e => e.to.node === pn.id).map(e => nodes.find(n => n.id === e.from.node)).find(n => n?.type === 'template');
      if (!tpl) continue;

      // Never publish images with literal {placeholder} text baked in — same guard the canvas applies.
      // A guard that can't run must BLOCK the publish (fail closed), not wave it through.
      let unmapped: string[];
      try {
        unmapped = await unmappedPlaceholders(db, tpl);
      } catch (e) {
        errors.push(`Could not verify the template's placeholders — not publishing. (${e instanceof Error ? e.message : 'check failed'})`);
        statusByNode[pn.id] = 'failed';
        continue;
      }
      if (unmapped.length) {
        errors.push(`Map every placeholder before posting — ${unmapped.map(f => `{${f}}`).join(', ')} ${unmapped.length > 1 ? 'are' : 'is'} unmapped in the template feeding this Post node.`);
        statusByNode[pn.id] = 'failed';
        continue;
      }

      const caption = typeof cfg.caption === 'string' ? cfg.caption : '';
      const contentType = (typeof cfg.contentType === 'string' ? cfg.contentType : 'feed') as IgContentType;
      // scheduledFor comes from a datetime-local input — an offset-LESS wall-clock string. Interpret it
      // in the timezone the panel captured (cfg.tz), never in server-local time: on UTC servers a bare
      // Date.parse posts hours early, or flips a future local time into "past" → publishes immediately.
      // A fixed scheduled time only makes sense while it's still in the future; recurring runs past it
      // publish immediately (posting late beats silently never posting).
      const tz = typeof cfg.tz === 'string' && cfg.tz.trim() ? cfg.tz.trim() : opts.fallbackTz;
      const schedAt = typeof cfg.scheduledFor === 'string' ? wallTimeToUtcMs(cfg.scheduledFor, tz) : NaN;
      const scheduled = cfg.when === 'schedule' && Number.isFinite(schedAt) && schedAt > Date.now();

      let nodeFailed = false;
      for (const postId of postIdsOf(tpl.id)) {
        let paths: string[] = [];
        try {
          const rendered = await renderPostToStorage(db, await getBrowser(), origin, flow.user_id, postId);
          if (!rendered.length) throw new Error('rendered no slides');
          // Same rule /api/schedule/post enforces — a multi-item story/reels payload is invalid and
          // would only fail later with an opaque provider error.
          if ((contentType === 'story' || contentType === 'reels') && rendered.length > 1) {
            throw new Error(`Instagram ${contentType} accepts a single media item — use a single-slide template or switch the Post node to feed`);
          }
          paths = rendered.map(r => r.path);
          // Safety net first — if this function dies mid-publish, the hourly sweep clears the files.
          await ledger(db, flow.user_id, `pending_${postId}`, paths, Date.now() + 3600_000);

          const mediaItems: MediaItem[] = rendered.slice(0, MAX_CAROUSEL).map(r => ({ type: 'image', url: r.url }));
          const post = await createInstagramPost({
            content: caption, profileId, accountId, mediaItems, contentType,
            publishNow: !scheduled,
            scheduledFor: scheduled ? new Date(schedAt).toISOString() : undefined,
            timezone: scheduled ? tz : undefined,
          });
          // Swap pending rows for rows keyed by the Zernio post id (cancel deletes them; sweep after publish).
          await db.from('scheduled_render_media').delete().in('path', paths);
          const expires = scheduled ? schedAt + 6 * 3600_000 : Date.now() + 30 * 60_000;
          await ledger(db, flow.user_id, (post as { _id?: string })._id ?? `auto_${postId}`, paths, expires);
          published++;
        } catch (e) {
          await deleteRenders(db, paths).catch(() => { /* pending ledger rows cover the leftovers */ });
          errors.push(`post ${postId}: ${e instanceof Error ? e.message : 'publish failed'}`);
          nodeFailed = true;
        }
      }
      statusByNode[pn.id] = nodeFailed ? 'failed' : scheduled ? 'scheduled' : 'posted';
    }
  } finally {
    // The generated posts are throwaway snapshots — delete them whatever happened (slides cascade).
    if (allGenerated.length) await db.from('template_editor_posts').delete().in('id', allGenerated);
  }

  return { published, errors, statusByNode };
}
