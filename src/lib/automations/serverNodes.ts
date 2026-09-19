import vm from 'node:vm';
import type { Item, NodeRegistry, RunContext, RunOutputs } from './types';
import { getAtPath, fillText } from './mapping';
import { isSafePublicUrl } from '@/lib/http';
import { rowToSlide, slideToRow } from '@/app/components/templateEditorRows';

// Server-side executable implementations for the node types. Runs in API routes only (never the
// browser) so secrets stay server-side and we avoid CORS. Secrets/DB/LLM arrive via ctx.services.

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Most source nodes wrap their payload as { status, ok, data }. Bindings/prompts target the inner
 *  `data`; unwrap it when present so paths are written against the actual response shape. */
function unwrap(json: unknown): unknown {
  return json && typeof json === 'object' && !Array.isArray(json) && 'data' in (json as object)
    ? (json as Record<string, unknown>).data
    : json;
}

const asString = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The single "input object" a fan-in consumer (AI prompt, code ctx.input, template bindings) sees.
 * One upstream source → its first item's (unwrapped) json, as before. Multiple distinct sources →
 * an object keyed by each source node's label (first item per source), matching the merged tree the
 * binding UI shows (AutomationsSection.incomingData) — so paths like "Prices.bitcoin.gbp" resolve
 * the same at bind time and run time.
 */
function mergedInput(items: Item[]): unknown {
  const bySource = new Map<string, Item>();
  for (const it of items) {
    const k = it.source ?? '';
    if (!bySource.has(k)) bySource.set(k, it);
  }
  if (bySource.size <= 1) return unwrap(items[0]?.json ?? {});
  const root: Record<string, unknown> = {};
  for (const [k, it] of bySource) root[k || 'input'] = unwrap(it.json);
  return root;
}

/** Resolve {{ path }} / {{ $json.path }} expressions in a prompt against the input data. `{{input}}`,
 *  `{{json}}` and `{{$json}}` stringify the whole object. Unknown paths resolve to ''. With `encode`,
 *  each substituted value is URL-encoded (for templated HTTP urls — a value must not be able to smuggle
 *  extra path segments or query params). */
function fillExpr(text: string, data: unknown, opts?: { encode?: boolean }): string {
  const emit = (v: unknown) => (opts?.encode ? encodeURIComponent(asString(v)) : asString(v));
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, raw) => {
    const expr = String(raw).trim();
    if (expr === 'input' || expr === 'json' || expr === '$json') return emit(data);
    const path = expr.replace(/^\$json\./, '').replace(/^json\./, '');
    let v = getAtPath(data, path);
    // "{{input.id}}" is the natural way to write it — when the literal path resolves nothing, retry
    // with the input. prefix stripped (kept as a fallback so a real top-level "input" key still wins).
    if (v === undefined && path.startsWith('input.')) v = getAtPath(data, path.slice(6));
    return emit(v);
  });
}

// ── HTTP (Source) ───────────────────────────────────────────────────────────

async function runHttp(ctx: RunContext): Promise<RunOutputs> {
  const c = ctx.config;
  const method = String(c.method ?? 'GET').toUpperCase();
  const rawUrl = String(c.url ?? '').trim();
  if (!rawUrl) throw new Error('URL is required');
  // {{ path }} data mapping: resolve template expressions against the merged upstream input (the same
  // data a code node's ctx.input sees), each value URL-encoded — enables chained calls like
  // .../coins/{{input.id}}/market_chart. Resolved BEFORE the SSRF check below, so the guard validates
  // the URL that is actually fetched, not the template.
  const url = rawUrl.includes('{{') ? fillExpr(rawUrl, mergedInput(ctx.inputs.in ?? []), { encode: true }) : rawUrl;
  // SSRF guard: reuse the app's DNS-resolving allow-public-only check (same helper the /proxy and
  // /download routes use) instead of a regex on the literal hostname — so a public name whose A-record
  // points at 169.254.169.254 / 127.0.0.1 / an internal host is rejected, and IPv6 / decimal-IP / CGNAT
  // forms are covered too. Redirects are followed MANUALLY below so every hop is re-validated.
  if (!(await isSafePublicUrl(url))) throw new Error('Blocked host (loopback/private network or unresolvable)');

  const headers: Record<string, string> = {};
  if (c.authentication === 'apiKey') {
    // Prefer a stored credential (id resolved server-side); fall back to an inline key for older flows.
    let key = '';
    if (c.credentialId && ctx.services?.getCredentialSecret) {
      key = (await ctx.services.getCredentialSecret(String(c.credentialId))) ?? '';
    } else if (c.apiKey) {
      key = String(c.apiKey);
    }
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  let body: string | undefined;
  if (c.sendBody && c.body != null && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    body = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
  }

  // Follow redirects manually, re-validating each Location against the SSRF guard (an allowed public
  // first host must not be able to 302 us onto an internal address). Mirrors proxy/route.ts.
  let currentUrl = url;
  let res = await fetch(currentUrl, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  for (let hops = 0; hops < 5 && [301, 302, 303, 307, 308].includes(res.status); hops++) {
    const location = res.headers.get('location');
    if (!location) break;
    const resolved = new URL(location, currentUrl).toString();
    if (!(await isSafePublicUrl(resolved))) throw new Error('Blocked redirect target (loopback/private network)');
    currentUrl = resolved;
    // 303 (and by convention 301/302 for non-GET) downgrade to GET without a body.
    const nextMethod = res.status === 303 ? 'GET' : method;
    const nextBody = nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : body;
    res = await fetch(currentUrl, { method: nextMethod, headers, body: nextBody, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  }
  const text = await res.text();
  const capped = text.length > 200_000 ? text.slice(0, 200_000) : text; // cap response size
  let data: unknown;
  try { data = JSON.parse(capped); } catch { data = capped; }

  return { out: [{ json: { status: res.status, ok: res.ok, data } }] };
}

// ── AI (Source) — prompt + user-defined output schema → structured JSON ───────
// Phase 3. Emits ONE item whose json is the parsed model output, so downstream Template bindings can
// target nested fields (e.g. slides.0.headline). Never composes a finished post — text/data only.
async function runAi(ctx: RunContext): Promise<RunOutputs> {
  const llm = ctx.services?.llm;
  if (!llm) throw new Error('AI node needs the server runtime (no LLM available)');
  const promptTpl = String(ctx.config.prompt ?? '').trim();
  if (!promptTpl) throw new Error('Prompt is required');
  const model = String(ctx.config.model ?? 'gemini-2.5-flash');

  const dataCtx = mergedInput(ctx.inputs.in ?? []);
  // Cap the interpolated prompt — upstream nodes (HTTP/code/fan-in) can produce huge payloads, and
  // input size is billed as tokens. 20k chars is plenty for a data-processing step.
  const prompt = fillExpr(promptTpl, dataCtx).slice(0, 20_000);

  let system =
    'You are a data-processing step in an automation. Process, classify, extract or derive values from ' +
    'the input. Return ONLY the fields the schema declares. Do NOT write social-media post copy or ' +
    'compose a finished/composited post — slide text is meshed into a template downstream.';
  let json = false;
  const schemaRaw = ctx.config.schema;
  let schema: unknown;
  if (schemaRaw) {
    try { schema = typeof schemaRaw === 'string' ? JSON.parse(schemaRaw) : schemaRaw; } catch { /* free-form */ }
    if (schema) {
      json = true;
      system += ` Respond with JSON only, matching this exact shape (same keys and value types): ${JSON.stringify(schema).slice(0, 4_000)}`;
    }
  }

  // Deadline: a hung LLM call must fail the node (and get reported) rather than stall the whole run —
  // the HTTP node has a fetch timeout, this is its equivalent.
  const llmCall = llm(prompt, { system, json, model, temperature: 0.4 });
  llmCall.catch(() => { /* late rejection after the timeout below is already reported */ });
  const text = await Promise.race([
    llmCall,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI step timed out (60s)')), 60_000)),
  ]);
  let out: Record<string, unknown>;
  if (json) {
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      const parsed = JSON.parse(stripped);
      out = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed };
    } catch {
      out = { text };
    }
  } else {
    out = { text };
  }
  return { out: [{ json: out }] };
}

// ── If (Logic) — route items to true/false on a simple condition ──────────────
// Phase 5. Safe single-comparison evaluator (no eval). Supports {{path}} on either side and the
// operators == != >= <= > < plus `contains`. An empty/operator-less condition tests truthiness.
function resolveSide(token: string, data: unknown): unknown {
  const t = token.trim();
  if (/^\{\{.*\}\}$/.test(t)) return getAtPath(data, t.slice(2, -2).trim().replace(/^\$json\./, '').replace(/^json\./, ''));
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^["'].*["']$/.test(t)) return t.slice(1, -1);
  // Bare word → treat as a path into the data (lets `value > 0` work without {{ }}).
  const v = getAtPath(data, t.replace(/^\$json\./, '').replace(/^json\./, ''));
  return v === undefined ? t : v;
}

function evalCondition(cond: string, data: unknown): boolean {
  let c = cond.trim();
  // Strip a wrapper only when it brackets the WHOLE expression (`{{ value > 5 }}`), not when individual
  // operands are wrapped (`{{value}} > 5`) — those `{{ }}` are resolved per-side by resolveSide.
  if (c.startsWith('{{') && c.endsWith('}}') && c.indexOf('{{', 2) === -1) c = c.slice(2, -2).trim();
  if (!c) return true;
  const m = c.match(/^(.*?)(==|!=|>=|<=|>|<|\bcontains\b)(.*)$/);
  if (!m) return Boolean(resolveSide(c, data)); // truthiness test
  const left = resolveSide(m[1], data);
  const op = m[2].trim();
  const right = resolveSide(m[3], data);
  switch (op) {
    case '==': return left == right;
    case '!=': return left != right;
    case '>':  return Number(left) >  Number(right);
    case '<':  return Number(left) <  Number(right);
    case '>=': return Number(left) >= Number(right);
    case '<=': return Number(left) <= Number(right);
    case 'contains': return asString(left).includes(asString(right));
    default: return false;
  }
}

function runIf(ctx: RunContext): RunOutputs {
  const cond = String(ctx.config.condition ?? '');
  const items = ctx.inputs.in ?? [];
  const yes: Item[] = [], no: Item[] = [];
  for (const it of items) (evalCondition(cond, unwrap(it.json)) ? yes : no).push(it);
  return { true: yes, false: no };
}

// ── Template (Render) — bind values into a carousel template → write a real post ──
// Phase 4. One post per incoming item (item-based fan-out); each post is a snapshot of the template's
// slides with {placeholders} in headline/subheadline/text boxes filled from the bound data.
async function runTemplate(ctx: RunContext): Promise<RunOutputs> {
  const db = ctx.services?.db;
  const userId = ctx.userId;
  if (!db || !userId) throw new Error('Template node needs the server runtime (no DB available)');

  const [kind, templateId] = String(ctx.config.templateId ?? '').split(':');
  if (!templateId) throw new Error('Pick a template first');
  if (kind !== 'carousel') throw new Error('Only carousel templates can be written for now');
  const bindings = (ctx.config.bindings && typeof ctx.config.bindings === 'object'
    ? ctx.config.bindings : {}) as Record<string, string>;

  // Verify ownership and load the template's slides.
  const { data: tpl } = await db.from('template_editor_templates').select('id,name').eq('id', templateId).eq('user_id', userId).maybeSingle();
  if (!tpl) throw new Error('Template not found');
  const { data: slideRows } = await db.from('template_editor_slides').select('*').eq('template_id', templateId).order('position', { ascending: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slides = ((slideRows ?? []) as Record<string, any>[]).map(rowToSlide);
  if (slides.length === 0) throw new Error('Template has no slides');

  // One SOURCE, many items → fan out (one post per item), as before. Multiple distinct sources →
  // JOIN: a single post whose bindings address each upstream by its node label ("Prices.bitcoin.gbp"),
  // mirroring the merged tree the binding picker showed. mergedInput returns the label-keyed root;
  // wrap it back into an item so the per-item loop below stays uniform.
  const rawItems = ctx.inputs.data ?? [];
  const distinctSources = new Set(rawItems.map(i => i.source ?? ''));
  const items: Item[] = rawItems.length === 0
    ? [{ json: {} }]
    : distinctSources.size > 1
      ? [{ json: mergedInput(rawItems) as Record<string, unknown> }]
      : rawItems;
  const out: Item[] = [];

  // An upstream that failed under continueOnFail emits a single { error } item. Rendering it would
  // fill every binding with '' and — on a scheduled flow — PUBLISH a blank carousel. Refuse instead:
  // the run fails at the template with the real upstream error.
  const errorOf = (v: unknown): string | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === 'error') return String(rec.error);
    // Fan-in root: any upstream branch that failed poisons the join the same way.
    for (const val of Object.values(rec)) {
      const nested = val && typeof val === 'object' && !Array.isArray(val) ? val as Record<string, unknown> : null;
      if (nested && Object.keys(nested).length === 1 && 'error' in nested) return String(nested.error);
    }
    return null;
  };

  for (let i = 0; i < items.length; i++) {
    const data = unwrap(items[i].json);
    const upstreamError = errorOf(data);
    if (upstreamError) throw new Error(`Upstream data failed (continue-on-fail): ${upstreamError}`);
    // Text {placeholders} get stringified values. `el:<feId>:<inputKey>` bindings carry the RAW value
    // (arrays/objects) into the matching custom element's data, so charts/tables in the generated post
    // are baked with THIS run's data — the post is a full snapshot, and whoever renders it (post-node
    // preview, publish step) sees the fresh chart without re-resolving bindings.
    const values: Record<string, string> = {};
    const elementData: Record<string, Record<string, unknown>> = {};
    // `bg:<slideId>` bindings map an IMAGE URL into that slide's background (injected below as a
    // full-canvas image box at the bottom of the layer stack). Only http(s) strings qualify.
    const bgBySlide: Record<string, string> = {};
    for (const [ph, path] of Object.entries(bindings)) {
      const el = /^el:([^:]+):(.+)$/.exec(ph);
      const bg = /^bg:(.+)$/.exec(ph);
      if (el) (elementData[el[1]] ??= {})[el[2]] = getAtPath(data, path);
      else if (bg) {
        const v = getAtPath(data, path);
        if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) bgBySlide[bg[1]] = v.trim();
      } else values[ph] = asString(getAtPath(data, path));
    }

    const { data: post, error: pErr } = await db
      .from('template_editor_posts')
      // ephemeral: throwaway run snapshot — hidden from the Carousels grid, deleted after publish/sweeps
      // (see supabase/automation_ephemeral_posts.sql).
      .insert({ user_id: userId, name: `${tpl.name} — automation`, position: 0, source_template_id: templateId, ephemeral: true })
      .select('id')
      .single();
    if (pErr || !post) throw new Error(pErr?.message ?? 'Failed to create post');

    const rows = slides.map((sl, idx) => {
      // Bound background → inject a full-canvas image box UNDER everything: prepended to imageBoxes
      // AND to layerOrderIds (ids missing from the order stack on TOP — orderedLayerIds), so it
      // behaves as the slide's background rather than a cover.
      const bgUrl = bgBySlide[sl.id];
      const bgBox = bgUrl
        ? [{ id: `autobg_${sl.id}`, url: bgUrl, x: 0, y: 0, width: 1080, height: 1350, opacity: 100, cornerRadius: 0, objectFit: 'cover' as const }]
        : [];
      return {
        ...slideToRow({
          ...sl,
          position: idx,
          headline: fillText(sl.headline, values),
          subheadline: fillText(sl.subheadline, values),
          settings: {
            ...sl.settings,
            imageBoxes: [...bgBox, ...sl.settings.imageBoxes],
            ...(bgUrl ? { layerOrderIds: [`autobg_${sl.id}`, ...(sl.settings.layerOrderIds ?? [])] } : {}),
            textBoxes: sl.settings.textBoxes.map(tb => ({ ...tb, text: fillText(tb.text, values) })),
            freeElements: (sl.settings.freeElements ?? []).map(fe =>
              fe.kind === 'custom' && elementData[fe.id]
                ? { ...fe, data: { ...(fe.data && typeof fe.data === 'object' ? fe.data as Record<string, unknown> : {}), ...elementData[fe.id] } }
                : fe),
          },
        }),
        post_id: post.id,
      };
    });
    const { error: sErr } = await db.from('template_editor_post_slides').insert(rows);
    if (sErr) {
      await db.from('template_editor_posts').delete().eq('id', post.id); // no client txns — roll back the orphan
      throw new Error(sErr.message);
    }
    out.push({ json: { postId: post.id, slideCount: slides.length, values }, pairedItem: items[i].pairedItem ?? i });
  }

  return { out };
}

// ── Code (Transform) — run a user/AI-authored run(ctx) in a scoped sandbox ────
// Phase 7 (v1 sandbox): node:vm with a fresh context (no require/process/fetch/globals) + a sync
// timeout. Good enough to run pure transforms; isolated-vm / containers come later for untrusted deps.
// The code node's return value IS its output data, emitted on the single `out` port (like every other
// source). An array fans out to one item per element; an object/primitive becomes a single item — so
// downstream Template bindings read `name`/`price`/… straight off it.
function toOutItems(result: unknown): RunOutputs {
  if (Array.isArray(result)) {
    return { out: result.map((el, i) => ({ json: (el && typeof el === 'object' ? el : { value: el }) as Record<string, unknown>, pairedItem: i })) };
  }
  if (result && typeof result === 'object') return { out: [{ json: result as Record<string, unknown> }] };
  return { out: [{ json: { value: result } }] };
}

// Run user/AI-authored code with node:vm, hardened against the classic sandbox escape.
//
// The old version invoked the resolved function IN THE HOST REALM with a host-created `arg`, so
// `arg.constructor.constructor("return process")()` reached the real `process` (→ service-role key,
// Stripe/credential secrets, RCE). This version closes that:
//   • the entry runs ENTIRELY inside the vm realm — never called from the host;
//   • its input crosses IN as a JSON string only (no host object is ever exposed to the code);
//   • only a JSON string crosses back OUT.
// With no host reference reachable inside, constructor-walking reaches the vm realm's own Function,
// where `process`/`require` are undefined — not the host's. A sync timeout stops infinite loops; a
// host-side deadline stops never-resolving async.
//
// NOTE: node:vm is defense-in-depth, not a formal isolate. Before automations are enabled broadly in
// production, move this to a true isolate (isolated-vm / QuickJS-WASM). See the readiness audit.
async function runCode(ctx: RunContext): Promise<RunOutputs> {
  const src = String(ctx.config.code ?? '').trim();
  if (!src) return { out: ctx.inputs.in ?? [] };

  // Contract: the entry receives ctx with `inputs` (items per port) AND `input` — the first input
  // port's first item json, unwrapped past any { data } envelope. input: one upstream → its parsed
  // json; multiple → keyed by source node label (see mergedInput).
  const argData = { inputs: ctx.inputs, config: ctx.config, input: mergedInput(ctx.inputs.in ?? []) };
  let argJson: string;
  try { argJson = JSON.stringify(argData ?? null); }
  catch { throw new Error('Code node input is not JSON-serializable'); }

  const stripped = src
    .replace(/export\s+default\s+/, '__default__ = ')
    .replace(/export\s+(async\s+)?function\s+/g, '$1function ')
    .replace(/export\s+(const|let|var)\s+/g, '$1 ');

  // Fresh realm. The only values placed on the global are primitive strings / undefined — never a host
  // object. `run`/`__default__` are pre-seeded so `run = …` / `export default …` assign to the global in
  // any mode. `__argJson` is passed as data (not string-interpolated into code) to avoid injection.
  const sandbox: Record<string, unknown> = {
    __argJson: argJson, run: undefined, __default__: undefined, __entry: undefined, __result__: undefined,
  };
  const context = vm.createContext(sandbox);
  const opts = { timeout: 2000 };

  try {
    // Resolve the entry with SEPARATE compilations (so a form that is valid as statements but not as an
    // expression, or vice-versa, doesn't fail the whole thing). Statement form first — a `run`/`__default__`
    // declaration or assignment lands on the context global; then fall back to a bare expression form.
    try { vm.runInContext(stripped, context, opts); } catch { /* not valid as statements; try expression form */ }
    vm.runInContext(`__entry = (typeof run === 'function' ? run : (typeof __default__ === 'function' ? __default__ : null));`, context, opts);
    if (typeof sandbox.__entry !== 'function') {
      try { vm.runInContext(`__entry = (${stripped});`, context, opts); } catch { /* fall through to the error below */ }
    }
    if (typeof sandbox.__entry !== 'function') {
      throw new Error('Code must define a run(ctx) function, export default a function, or be a single (ctx) => {…} function');
    }

    // Execute INSIDE the vm: JSON in (parsed to a realm-local object), JSON out. `__entry` is never
    // invoked from the host — so `arg.constructor.constructor(...)` reaches the realm's Function, where
    // `process`/`require` don't exist, not the host's. The sync timeout bounds a sync infinite loop; the
    // host-side race bounds a never-resolving async one.
    vm.runInContext(`__result__ = (async () => {
      const __arg = JSON.parse(__argJson);
      const __out = await __entry(__arg);
      return JSON.stringify(__out === undefined ? null : __out);
    })();`, context, opts);
    const resultJson = await Promise.race([
      sandbox.__result__ as Promise<string>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Code timed out')), 3000)),
    ]);
    let result: unknown;
    try { result = JSON.parse(resultJson); } catch { result = null; }
    return toOutItems(result);
  } catch (e) {
    throw new Error(`Code failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const serverNodeRegistry: NodeRegistry = {
  trigger: { id: 'trigger', run: () => ({ out: [{ json: {} }] }) },
  http: { id: 'http', run: runHttp },
  ai: { id: 'ai', run: runAi },
  code: { id: 'code', run: runCode },
  if: { id: 'if', run: runIf },
  template: { id: 'template', run: runTemplate },
  post: { id: 'post', run: () => ({}) },
  // Element (Render) — resolve the mapped inputs into the element's data shape (its input ports are the
  // element's input keys) and emit { elementId, data }. The pixel render to media stays client-side (the
  // app bakes all media in the browser), so this produces the resolved data the element would draw with;
  // turning that into posted media is a later integration. Never fails a run.
  element: {
    id: 'element',
    run: (ctx) => {
      const data: Record<string, unknown> = {};
      for (const [key, items] of Object.entries(ctx.inputs ?? {})) {
        if (!items || items.length === 0) continue;
        data[key] = items.length === 1 ? unwrap(items[0].json) : items.map(it => unwrap(it.json));
      }
      return { out: [{ json: { elementId: ctx.config.elementId ?? null, data } }] };
    },
  },
};
