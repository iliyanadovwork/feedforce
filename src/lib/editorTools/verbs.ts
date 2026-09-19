// The editor tools service layer — every verb an agent (in-app copilot, automations, MCP) can run
// against the template editors' persisted state. Server-only (import from API routes).
//
// Auth model: every verb runs on a CALLER-SCOPED Supabase client (the user's JWT rides each
// request), so RLS enforces ownership — no service-role writes on behalf of users.
//
// Validation model: PATCHES are validated strictly (unknown keys / bad enums rejected with
// field-level errors the model can self-correct from). The merged result is NOT re-validated —
// legacy rows carry pre-schema quirks (e.g. `false` fillers in logo slot arrays) that must stay
// editable. Merge semantics are mergePatch's: objects merge deep, arrays/primitives replace.

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { rowToSlide, slideToRow } from '@/app/components/templateEditorRows';
import type { SlideRow } from '@/app/components/templateEditorRows';
import type { CarouselSettings } from '@/app/components/templateEditorTypes';
import { defaultCarouselSettings } from '@/app/components/templateEditorTypes';
import { resolveTwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';
import {
  zCarouselSettingsPatch, zTextBoxPatch, zImageBoxPatch, zTextBoxStyle, zImageBox, zFreeElement,
} from './carouselSchema';
import { validateFreeElementPatch } from './agentActions';
import { zTwitterTemplateSettingsPatch } from './reelsSchema';
import { compactCarouselSettings, compactReelSettings, mergePatch } from './compact';

export class VerbError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SLIDE_KINDS = {
  carousel: { parent: 'template_editor_templates', slides: 'template_editor_slides', fk: 'template_id' },
  posts: { parent: 'template_editor_posts', slides: 'template_editor_post_slides', fk: 'post_id' },
} as const;
type SlideKind = keyof typeof SLIDE_KINDS;

const zSlideKind = z.enum(['carousel', 'posts']);
const zAnyKind = z.enum(['carousel', 'posts', 'reels']);

/** Per-call client carrying the caller's JWT so RLS resolves auth.uid() to them. */
export function callerClient(token: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new VerbError('Supabase env not configured', 500);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function fail(error: { message: string } | null, what: string): never {
  throw new VerbError(`${what}: ${error?.message ?? 'not found'}`, 400);
}

function compactSlide(slide: SlideRow) {
  return {
    id: slide.id,
    name: slide.name,
    position: slide.position,
    headline: slide.headline,
    subheadline: slide.subheadline,
    // Only the fields that differ from defaults — reconstruct with mergePatch(defaults, settings).
    settings: compactCarouselSettings(slide.settings),
  };
}

async function fetchSlide(db: SupabaseClient, kind: SlideKind, slideId: string): Promise<SlideRow> {
  const t = SLIDE_KINDS[kind];
  const { data, error } = await db.from(t.slides).select('*').eq('id', slideId).maybeSingle();
  if (error || !data) fail(error, `read ${t.slides}`);
  return rowToSlide(data);
}

async function writeSlide(db: SupabaseClient, kind: SlideKind, slide: SlideRow): Promise<void> {
  const t = SLIDE_KINDS[kind];
  const { error } = await db.from(t.slides).update(slideToRow(slide)).eq('id', slide.id);
  if (error) fail(error, `write ${t.slides}`);
}

// ── Args schemas (one per verb — these double as the tool-definition source for agents/MCP) ──

const zListTemplates = z.strictObject({ kind: zAnyKind });
const zGetTemplate = z.strictObject({ kind: zAnyKind, templateId: z.string() });
const zGetSlide = z.strictObject({ kind: zSlideKind, slideId: z.string() });
const zPatchSlide = z.strictObject({
  kind: zSlideKind,
  slideId: z.string(),
  name: z.string().optional(),
  headline: z.string().optional(),
  subheadline: z.string().optional(),
  settings: zCarouselSettingsPatch.optional(),
});
const zPatchItem = z.strictObject({
  kind: zSlideKind,
  slideId: z.string(),
  id: z.string(),
  patch: z.record(z.string(), z.unknown()),
});
const zCreateSlide = z.strictObject({
  kind: zSlideKind,
  templateId: z.string(),
  name: z.string().optional(),
  copyFromSlideId: z.string().optional(),
});
const zDeleteSlide = z.strictObject({ kind: zSlideKind, slideId: z.string() });
const zReorderSlides = z.strictObject({ kind: zSlideKind, templateId: z.string(), orderedIds: z.array(z.string()).min(1) });
const zCreateTemplate = z.strictObject({ kind: z.enum(['carousel', 'reels']), name: z.string().optional() });
const zRenameTemplate = z.strictObject({ kind: zAnyKind, templateId: z.string(), name: z.string().min(1) });
const zDeleteTemplate = z.strictObject({ kind: zAnyKind, templateId: z.string() });
const zPatchReelTemplate = z.strictObject({
  templateId: z.string(),
  name: z.string().optional(),
  settings: zTwitterTemplateSettingsPatch.optional(),
});
const zUploadMedia = z.strictObject({
  kind: z.enum(['image', 'video']),
  dataBase64: z.string().min(16).max(12_000_000),   // ~9MB binary — enough for editor media
  contentType: z.string().optional(),
  filename: z.string().optional(),
});

// ── Verbs ─────────────────────────────────────────────────────────────────────

export async function listTemplates(db: SupabaseClient, rawArgs: unknown) {
  const { kind } = zListTemplates.parse(rawArgs);
  const table = kind === 'reels' ? 'twitter_templates' : SLIDE_KINDS[kind].parent;
  const { data, error } = await db.from(table).select('id, name, position').order('position');
  if (error) fail(error, `list ${table}`);
  return { kind, templates: data };
}

export async function getTemplate(db: SupabaseClient, rawArgs: unknown) {
  const { kind, templateId } = zGetTemplate.parse(rawArgs);
  if (kind === 'reels') {
    const { data, error } = await db.from('twitter_templates').select('*').eq('id', templateId).maybeSingle();
    if (error || !data) fail(error, 'read twitter_templates');
    return {
      kind,
      id: data.id,
      name: data.name,
      settings: compactReelSettings(resolveTwitterTemplateSettings(data.settings)),
    };
  }
  const t = SLIDE_KINDS[kind];
  const { data: parent, error: pErr } = await db.from(t.parent).select('id, name, position').eq('id', templateId).maybeSingle();
  if (pErr || !parent) fail(pErr, `read ${t.parent}`);
  const { data: slides, error: sErr } = await db.from(t.slides).select('*').eq(t.fk, templateId).order('position');
  if (sErr) fail(sErr, `read ${t.slides}`);
  return { kind, id: parent.id, name: parent.name, slides: (slides ?? []).map(r => compactSlide(rowToSlide(r))) };
}

export async function getSlide(db: SupabaseClient, rawArgs: unknown) {
  const { kind, slideId } = zGetSlide.parse(rawArgs);
  return { kind, slide: compactSlide(await fetchSlide(db, kind, slideId)) };
}

export async function patchSlide(db: SupabaseClient, rawArgs: unknown) {
  const args = zPatchSlide.parse(rawArgs);
  const slide = await fetchSlide(db, args.kind, args.slideId);
  if (args.name !== undefined) slide.name = args.name;
  if (args.headline !== undefined) slide.headline = args.headline;
  if (args.subheadline !== undefined) slide.subheadline = args.subheadline;
  if (args.settings) {
    slide.settings = mergePatch(
      slide.settings as unknown as Record<string, unknown>,
      args.settings as Record<string, unknown>,
    ) as unknown as CarouselSettings;
  }
  await writeSlide(db, args.kind, slide);
  return { kind: args.kind, slide: compactSlide(slide) };
}

// Targeted item patches — cheaper than resending a whole array to change one box.
// The merged item is validated against its FULL schema when it parses cleanly as-is; items with
// legacy extra keys skip that check (the patch itself was already validated shape-by-shape).
type ItemField = 'textBoxes' | 'imageBoxes' | 'freeElements';

async function patchArrayItem(
  db: SupabaseClient,
  rawArgs: unknown,
  field: ItemField,
  patchSchema: z.ZodType | null,   // null → free elements (validated per-kind after the item is found)
) {
  const args = zPatchItem.parse(rawArgs);
  const slide = await fetchSlide(db, args.kind, args.slideId);
  const arr = (slide.settings[field] ?? []) as { id: string }[];
  const idx = arr.findIndex(item => item.id === args.id);
  if (idx < 0) throw new VerbError(`No ${field} item with id ${args.id} on slide ${args.slideId}`, 404);
  // Validate the patch against the field's DEEP-partial patch schema. Free elements are a
  // discriminated union, validated per the matched item's kind (kind changes + custom-element
  // code/data rewrites are rejected there — code only enters through the gated element pipeline).
  if (field === 'freeElements') {
    const kind = (arr[idx] as { kind?: string }).kind ?? '';
    const problem = validateFreeElementPatch(kind, args.patch);
    if (problem) throw new VerbError(`Invalid ${field} patch: ${problem}`);
  } else if (patchSchema) {
    const res = patchSchema.safeParse(args.patch);
    if (!res.success) {
      throw new VerbError(`Invalid ${field} patch: ${res.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
  }
  const merged = mergePatch(arr[idx] as unknown as Record<string, unknown>, args.patch);
  merged.id = args.id;   // the patch must not re-identify the item
  const next = [...arr];
  next[idx] = merged as unknown as { id: string };
  (slide.settings as unknown as Record<string, unknown>)[field] = next;
  await writeSlide(db, args.kind, slide);
  return { kind: args.kind, slideId: args.slideId, [field.slice(0, -2)]: merged };
}

export async function patchTextBox(db: SupabaseClient, rawArgs: unknown) {
  return patchArrayItem(db, rawArgs, 'textBoxes', zTextBoxPatch);
}
export async function patchImageBox(db: SupabaseClient, rawArgs: unknown) {
  return patchArrayItem(db, rawArgs, 'imageBoxes', zImageBoxPatch);
}
export async function patchFreeElement(db: SupabaseClient, rawArgs: unknown) {
  return patchArrayItem(db, rawArgs, 'freeElements', null);
}

// Add items: full, strictly-validated objects (id generated when omitted is the caller's job —
// agents send complete items; the schemas require `id`, so generate before calling).
const zAddItem = z.strictObject({
  kind: zSlideKind,
  slideId: z.string(),
  textBox: zTextBoxStyle.optional(),
  imageBox: zImageBox.optional(),
  freeElement: zFreeElement.optional(),
});

export async function addSlideItem(db: SupabaseClient, rawArgs: unknown) {
  const args = zAddItem.parse(rawArgs);
  const provided = [args.textBox && 'textBoxes', args.imageBox && 'imageBoxes', args.freeElement && 'freeElements']
    .filter(Boolean) as ItemField[];
  if (provided.length !== 1) throw new VerbError('Provide exactly one of textBox | imageBox | freeElement.');
  const field = provided[0];
  const item = (args.textBox ?? args.imageBox ?? args.freeElement)!;
  // SECURITY: custom elements carry executable draw-code; agents must not author it directly.
  // The only sanctioned entry is the element pipeline (/api/elements/generate + its code guards).
  if (field === 'freeElements' && (item as { kind?: string }).kind === 'custom') {
    throw new VerbError('Custom elements cannot be added through this API — generate them via the element builder.');
  }
  const slide = await fetchSlide(db, args.kind, args.slideId);
  const settings = slide.settings as unknown as Record<string, unknown>;
  const arr = (settings[field] ?? []) as { id: string }[];
  if (arr.some(existing => existing.id === item.id)) throw new VerbError(`An item with id ${item.id} already exists.`);
  settings[field] = [...arr, item];
  await writeSlide(db, args.kind, slide);
  return { kind: args.kind, slideId: args.slideId, added: item.id };
}

const zRemoveItem = z.strictObject({
  kind: zSlideKind,
  slideId: z.string(),
  field: z.enum(['textBoxes', 'imageBoxes', 'freeElements']),
  id: z.string(),
});

export async function removeSlideItem(db: SupabaseClient, rawArgs: unknown) {
  const args = zRemoveItem.parse(rawArgs);
  const slide = await fetchSlide(db, args.kind, args.slideId);
  const settings = slide.settings as unknown as Record<string, unknown>;
  const arr = (settings[args.field] ?? []) as { id: string }[];
  if (!arr.some(item => item.id === args.id)) throw new VerbError(`No ${args.field} item with id ${args.id}`, 404);
  settings[args.field] = arr.filter(item => item.id !== args.id);
  await writeSlide(db, args.kind, slide);
  return { kind: args.kind, slideId: args.slideId, removed: args.id };
}

export async function createSlide(db: SupabaseClient, rawArgs: unknown) {
  const args = zCreateSlide.parse(rawArgs);
  const t = SLIDE_KINDS[args.kind];
  const { data: existing, error: exErr } = await db.from(t.slides)
    .select('position').eq(t.fk, args.templateId).order('position', { ascending: false }).limit(1);
  if (exErr) fail(exErr, `read ${t.slides}`);
  const position = existing?.length ? (existing[0].position as number) + 1 : 0;

  let base: SlideRow;
  if (args.copyFromSlideId) {
    base = await fetchSlide(db, args.kind, args.copyFromSlideId);
  } else {
    base = {
      id: '', templateId: args.templateId, name: '', position,
      headline: '', subheadline: '', settings: defaultCarouselSettings(),
    };
  }
  const row = {
    ...slideToRow({ ...base, name: args.name ?? (args.copyFromSlideId ? `${base.name} copy` : `Slide ${position + 1}`), position }),
    [t.fk]: args.templateId,
  };
  const { data, error } = await db.from(t.slides).insert(row).select('id').single();
  if (error || !data) fail(error, `insert ${t.slides}`);
  return { kind: args.kind, slideId: data.id, position };
}

export async function deleteSlide(db: SupabaseClient, rawArgs: unknown) {
  const args = zDeleteSlide.parse(rawArgs);
  const t = SLIDE_KINDS[args.kind];
  const { error } = await db.from(t.slides).delete().eq('id', args.slideId);
  if (error) fail(error, `delete ${t.slides}`);
  return { kind: args.kind, deleted: args.slideId };
}

export async function reorderSlides(db: SupabaseClient, rawArgs: unknown) {
  const args = zReorderSlides.parse(rawArgs);
  const t = SLIDE_KINDS[args.kind];
  for (let i = 0; i < args.orderedIds.length; i++) {
    const { error } = await db.from(t.slides).update({ position: i }).eq('id', args.orderedIds[i]).eq(t.fk, args.templateId);
    if (error) fail(error, `reorder ${t.slides}`);
  }
  return { kind: args.kind, order: args.orderedIds };
}

export async function createTemplate(db: SupabaseClient, userId: string, rawArgs: unknown) {
  const args = zCreateTemplate.parse(rawArgs);
  if (args.kind === 'reels') {
    const { data, error } = await db.from('twitter_templates')
      .insert({ user_id: userId, name: args.name ?? 'Untitled template', settings: {} })
      .select('id').single();
    if (error || !data) fail(error, 'insert twitter_templates');
    return { kind: args.kind, templateId: data.id };
  }
  const t = SLIDE_KINDS.carousel;
  const { data: parent, error: pErr } = await db.from(t.parent)
    .insert({ user_id: userId, name: args.name ?? 'Untitled template' })
    .select('id').single();
  if (pErr || !parent) fail(pErr, `insert ${t.parent}`);
  // Seed slide 0 so the editor opens on something (mirrors useTemplateEditor.createTemplate).
  const seed = {
    ...slideToRow({
      id: '', templateId: parent.id, name: 'main', position: 0,
      headline: '', subheadline: '', settings: defaultCarouselSettings(),
    }),
    [t.fk]: parent.id,
  };
  const { error: sErr } = await db.from(t.slides).insert(seed);
  if (sErr) fail(sErr, `seed ${t.slides}`);
  return { kind: args.kind, templateId: parent.id };
}

export async function renameTemplate(db: SupabaseClient, rawArgs: unknown) {
  const args = zRenameTemplate.parse(rawArgs);
  const table = args.kind === 'reels' ? 'twitter_templates' : SLIDE_KINDS[args.kind].parent;
  const { error } = await db.from(table).update({ name: args.name }).eq('id', args.templateId);
  if (error) fail(error, `rename ${table}`);
  return { kind: args.kind, templateId: args.templateId, name: args.name };
}

export async function deleteTemplate(db: SupabaseClient, rawArgs: unknown) {
  const args = zDeleteTemplate.parse(rawArgs);
  const table = args.kind === 'reels' ? 'twitter_templates' : SLIDE_KINDS[args.kind].parent;
  const { error } = await db.from(table).delete().eq('id', args.templateId);
  if (error) fail(error, `delete ${table}`);
  return { kind: args.kind, deleted: args.templateId };
}

export async function patchReelTemplate(db: SupabaseClient, rawArgs: unknown) {
  const args = zPatchReelTemplate.parse(rawArgs);
  const { data, error } = await db.from('twitter_templates').select('*').eq('id', args.templateId).maybeSingle();
  if (error || !data) fail(error, 'read twitter_templates');
  const update: Record<string, unknown> = {};
  if (args.name !== undefined) update.name = args.name;
  if (args.settings) {
    const current = resolveTwitterTemplateSettings(data.settings);
    update.settings = mergePatch(current as unknown as Record<string, unknown>, args.settings as Record<string, unknown>);
  }
  if (Object.keys(update).length === 0) throw new VerbError('Nothing to update — provide name and/or settings.');
  const { error: wErr } = await db.from('twitter_templates').update(update).eq('id', args.templateId);
  if (wErr) fail(wErr, 'write twitter_templates');
  return {
    kind: 'reels' as const,
    templateId: args.templateId,
    settings: update.settings ? compactReelSettings(update.settings as never) : undefined,
  };
}

// Media upload: base64 only (no URL fetch — that would be an SSRF hole). Returns the public URL
// to place into image boxes / free elements / reel cells.
export async function uploadMedia(db: SupabaseClient, userId: string, rawArgs: unknown) {
  const args = zUploadMedia.parse(rawArgs);
  const bucket = args.kind === 'video' ? 'post-videos' : 'post-images';
  const raw = args.dataBase64.replace(/^data:[^;]+;base64,/, '');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, 'base64');
  } catch {
    throw new VerbError('dataBase64 is not valid base64.');
  }
  if (bytes.length < 16) throw new VerbError('Media payload is empty.');
  const safe = (args.filename?.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || args.kind).slice(0, 80);
  const path = `${userId}/${Date.now()}_${safe}`;
  const contentType = args.contentType ?? (args.kind === 'video' ? 'video/mp4' : 'image/png');
  const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType });
  if (error) fail(error, `upload to ${bucket}`);
  const { data: { publicUrl } } = db.storage.from(bucket).getPublicUrl(path);
  return { url: publicUrl, bucket, path };
}

// ── Dispatch table (the route + future MCP server both consume this) ─────────
// Uniform signature: (db, userId, args) — verbs that don't need userId ignore it.
type VerbFn = (db: SupabaseClient, userId: string, args: unknown) => Promise<unknown>;

export const VERBS: Record<string, VerbFn> = {
  list_templates: (db, _u, a) => listTemplates(db, a),
  get_template: (db, _u, a) => getTemplate(db, a),
  get_slide: (db, _u, a) => getSlide(db, a),
  patch_slide: (db, _u, a) => patchSlide(db, a),
  patch_text_box: (db, _u, a) => patchTextBox(db, a),
  patch_image_box: (db, _u, a) => patchImageBox(db, a),
  patch_free_element: (db, _u, a) => patchFreeElement(db, a),
  add_slide_item: (db, _u, a) => addSlideItem(db, a),
  remove_slide_item: (db, _u, a) => removeSlideItem(db, a),
  create_slide: (db, _u, a) => createSlide(db, a),
  delete_slide: (db, _u, a) => deleteSlide(db, a),
  reorder_slides: (db, _u, a) => reorderSlides(db, a),
  create_template: (db, u, a) => createTemplate(db, u, a),
  rename_template: (db, _u, a) => renameTemplate(db, a),
  delete_template: (db, _u, a) => deleteTemplate(db, a),
  patch_reel_template: (db, _u, a) => patchReelTemplate(db, a),
  upload_media: (db, u, a) => uploadMedia(db, u, a),
};

export type VerbName = keyof typeof VERBS;
