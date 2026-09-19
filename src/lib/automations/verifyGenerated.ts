import type { Edge, FlowNode } from './types';
import { getAtPath } from './mapping';
import { NODE_DESCRIPTORS } from './descriptors';

// Deterministic verification of AI-generated flows (the chat builder's /generate route). The LLM's
// "fix" used to be taken on faith — it could return code that provably fails against the very data the
// user just ran, and the panel would apply it anyway. This closes the loop without any extra LLM call:
//   • STATIC: a code node with exactly ONE upstream reading ctx.input["Some Label"] can never work —
//     label-keyed input exists only for fan-in (serverNodes.mergedInput). Caught with no run data at all.
//   • DYNAMIC: when the client sent the last run's real outputs, execute the generated code (in the same
//     vm sandbox real runs use, injected as `runCode`) against the upstream's actual emitted data and
//     reject empty / {error}-shaped results.
//   • MAPPINGS: {{ }} paths in http URLs / AI prompts / if conditions, and template bindings, are
//     resolved against the same real samples — a path that resolves to nothing is reported.
// The route feeds any problems back to the model as an automated correction turn and re-asks.
//
// Emitted-sample lookup convention: the map is keyed by node LABEL (the client's run report rows) AND,
// when the client sent ids, by `id:<nodeId>` — id wins (labels are fuzzy: the client derives them as
// `node.label ?? node.type`, and unlabeled nodes collide).

/** Runs a code node's source against one input and returns its emitted items (serverNodes runCode). */
export type GeneratedCodeRunner = (code: string, input: unknown) => Promise<Array<{ json: Record<string, unknown> }>>;

/** Same envelope-stripping the engine applies between nodes (serverNodes.unwrap — keep in sync). */
function unwrap(json: unknown): unknown {
  return json && typeof json === 'object' && !Array.isArray(json) && 'data' in (json as object)
    ? (json as Record<string, unknown>).data
    : json;
}

/** An {error: "..."}-only object is the generated code's own failure signal, not usable output. */
function isErrorShape(json: Record<string, unknown>): boolean {
  const keys = Object.keys(json);
  return keys.length === 1 && (keys[0] === 'error' || (keys[0] === 'value' && json.value == null));
}

const clip = (v: unknown, max = 800): string => {
  const s = JSON.stringify(v ?? null) ?? 'null';
  return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
};

/** Raw emitted sample for a node — by id first (exact), then by its label / descriptor-label / type
 *  (the derivations the client and engine use for display labels). undefined = not grounded. */
function emittedFor(node: FlowNode, emitted: Map<string, unknown>): unknown {
  if (emitted.has(`id:${node.id}`)) return emitted.get(`id:${node.id}`);
  const candidates = [node.label, NODE_DESCRIPTORS[node.type]?.label, node.type].filter((s): s is string => !!s);
  for (const key of candidates) if (emitted.has(key)) return emitted.get(key);
  return undefined;
}
function isGrounded(node: FlowNode, emitted: Map<string, unknown>): boolean {
  if (emitted.has(`id:${node.id}`)) return true;
  return [node.label, NODE_DESCRIPTORS[node.type]?.label, node.type].some(k => !!k && emitted.has(k));
}

/** Distinct upstream source nodes feeding `node` (any input port), in edge order. */
function upstreamsOf(node: FlowNode, nodes: FlowNode[], edges: Edge[]): FlowNode[] {
  const ids = [...new Set(edges.filter(e => e.to.node === node.id).map(e => e.from.node))];
  return ids.map(id => nodes.find(n => n.id === id)).filter((n): n is FlowNode => !!n);
}

/** Display label an upstream gets in fan-in input objects — mirrors graph.ts sourceLabels. */
function displayLabel(n: FlowNode): string {
  return n.label || NODE_DESCRIPTORS[n.type]?.label || n.id;
}

/**
 * The merged input a node would receive, built from real emitted samples (mirrors serverNodes
 * mergedInput): one upstream → its unwrapped sample; several → an object keyed by display label
 * (duplicates get " 2", " 3"…). Returns undefined when ANY upstream is ungrounded — a partial
 * merge would produce false "path resolves to nothing" reports.
 */
function sampleInputFor(node: FlowNode, nodes: FlowNode[], edges: Edge[], emitted: Map<string, unknown>): unknown | undefined {
  const ups = upstreamsOf(node, nodes, edges);
  if (ups.length === 0) return undefined;
  if (!ups.every(u => isGrounded(u, emitted))) return undefined;
  if (ups.length === 1) return unwrap(emittedFor(ups[0], emitted));
  const used = new Map<string, number>();
  const root: Record<string, unknown> = {};
  for (const u of ups) {
    const base = displayLabel(u);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    root[n === 1 ? base : `${base} ${n}`] = unwrap(emittedFor(u, emitted));
  }
  return root;
}

/** Resolve a {{ }} expression path the way serverNodes.fillExpr does (keep in sync). */
function resolveExprPath(expr: string, data: unknown): unknown {
  const e = expr.trim();
  if (e === 'input' || e === 'json' || e === '$json') return data;
  const path = e.replace(/^\$json\./, '').replace(/^json\./, '');
  let v = getAtPath(data, path);
  if (v === undefined && path.startsWith('input.')) v = getAtPath(data, path.slice(6));
  return v;
}

const exprTokens = (text: string): string[] => {
  const out: string[] = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
};

/**
 * The HTTP source nodes that feed single-upstream code nodes but have NO last-run data to verify
 * against. The route runs these live (GET-only, SSRF-guarded runHttp) before verification, so revised
 * code is always checked against the source's REAL current response shape — the "run the source first,
 * see the shape, then write the transform" discipline the build agent uses, applied to revisions.
 */
export function ungroundedHttpUpstreams(nodes: FlowNode[], edges: Edge[], emittedByLabel: Map<string, unknown>): FlowNode[] {
  const out: FlowNode[] = [];
  for (const node of nodes) {
    if (node.type !== 'code' || !String(node.config?.code ?? '').trim()) continue;
    const sources = upstreamsOf(node, nodes, edges);
    if (sources.length !== 1) continue;
    const up = sources[0];
    if (up.type !== 'http' || isGrounded(up, emittedByLabel)) continue;
    if (!out.some(x => x.id === up.id)) out.push(up);
  }
  return out;
}

/**
 * Check every generated code node; returns human-readable problems for the model re-ask (empty = pass).
 * `emittedByLabel` maps node labels (and `id:<id>` keys) to their RAW last-run output (envelope
 * included — unwrapped here, exactly like the engine does before the code sees it).
 */
export async function verifyGeneratedCodeNodes(
  nodes: FlowNode[],
  edges: Edge[],
  emittedByLabel: Map<string, unknown>,
  runCode: GeneratedCodeRunner,
): Promise<string[]> {
  const problems: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'code') continue;
    const code = String(node.config?.code ?? '').trim();
    if (!code) continue;
    const label = node.label || 'Code';
    const sources = upstreamsOf(node, nodes, edges);
    if (sources.length !== 1) continue; // fan-in inputs aren't reconstructable here — dynamic runs cover them
    const upstream = sources[0];
    const grounded = isGrounded(upstream, emittedByLabel);
    const input = grounded ? unwrap(emittedFor(upstream, emittedByLabel)) : undefined;
    // The real ctx.input rides along in every failure message so the model's retry is grounded even
    // when the original prompt carried no run report.
    const sample = grounded ? ` Its REAL ctx.input is: ${clip(input)}` : '';

    // Static: single upstream + label-keyed ctx.input access is undefined by construction.
    if (/ctx\.input\s*\[\s*['"`]/.test(code)) {
      problems.push(`Code node "${label}" has exactly ONE upstream node, so ctx.input IS that node's data directly — ctx.input["…"] is undefined there. Read ctx.input itself (label-keyed input exists only when 2+ nodes fan into the same port).${sample}`);
      continue;
    }

    // Dynamic: ground-truth the code against what its upstream REALLY emitted (last run or live probe).
    if (!grounded) continue;
    const where = `Code node "${label}", executed against the REAL data its upstream "${displayLabel(upstream)}" emitted,`;
    try {
      const items = await runCode(code, input);
      if (items.length === 0) problems.push(`${where} returned an empty array — not usable output.${sample}`);
      else if (items.length === 1 && isErrorShape(items[0].json)) {
        problems.push(`${where} returned ${JSON.stringify(items[0].json).slice(0, 300)} — its own failure path fired, so its data access is still wrong.${sample}`);
      }
    } catch (e) {
      problems.push(`${where} threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}.${sample}`);
    }
  }
  return problems;
}

/**
 * Deterministic mapping checks against real samples: {{ }} paths in http URLs, AI prompts and if
 * conditions, plus template `bindings` paths, must resolve to SOMETHING in the data the node would
 * actually receive. Nodes whose upstreams have no samples are skipped (nothing to check against).
 */
export function verifyMappings(nodes: FlowNode[], edges: Edge[], emitted: Map<string, unknown>): string[] {
  const problems: string[] = [];
  const report = (node: FlowNode, what: string, path: string, sample: unknown) => {
    problems.push(`${what} on node "${displayLabel(node)}" references "${path}", which resolves to NOTHING in the real data it receives: ${clip(sample)}. Use a path that exists in that data.`);
  };

  for (const node of nodes) {
    const cfg = node.config ?? {};
    const sample = sampleInputFor(node, nodes, edges, emitted);
    if (sample === undefined) continue;

    if (node.type === 'http') {
      const url = String(cfg.url ?? '');
      for (const tok of exprTokens(url)) {
        if (resolveExprPath(tok, sample) === undefined) report(node, 'The http URL {{ }} mapping', tok, sample);
      }
    } else if (node.type === 'ai') {
      for (const tok of exprTokens(String(cfg.prompt ?? ''))) {
        if (resolveExprPath(tok, sample) === undefined) report(node, 'The AI prompt {{ }} mapping', tok, sample);
      }
    } else if (node.type === 'if') {
      for (const tok of exprTokens(String(cfg.condition ?? ''))) {
        // A whole-expression wrapper ({{ value > 5 }}) isn't a bare path — only check path-like tokens.
        if (/[<>=!]|\bcontains\b/.test(tok)) continue;
        if (resolveExprPath(tok, sample) === undefined) report(node, 'The if condition', tok, sample);
      }
    } else if (node.type === 'template') {
      const bindings = (cfg.bindings && typeof cfg.bindings === 'object' ? cfg.bindings : {}) as Record<string, string>;
      for (const [ph, path] of Object.entries(bindings)) {
        if (!path || typeof path !== 'string') continue;
        if (getAtPath(sample, path) === undefined) report(node, `The template binding for {${ph}}`, path, sample);
      }
    }
  }
  return problems;
}

export interface TemplateCatalogEntry {
  value: string;
  name: string;
  placeholders: string[];
  /** Slide-background binding keys (`bg:<slideId>`) — every slide's bg is bindable to an image URL. */
  bgKeys?: string[];
}

export interface TemplateVerifyOptions {
  /** templateIds already present in the CURRENT graph — a user's existing choice is never flagged,
   *  even when it sits outside the (capped) catalog we fetched. */
  preexisting?: Set<string>;
  /** The catalog hit its fetch cap — membership is unknowable, so not-found is NOT a problem. */
  truncated?: boolean;
}

/**
 * Template-node config checks against the user's REAL template catalog: templateId must be one of the
 * user's templates, and every binding key must be one of that template's {placeholders} (or an
 * `el:<feId>:<input>` chart-element key, which this check can't enumerate — those pass).
 */
export function verifyTemplateConfig(nodes: FlowNode[], templates: TemplateCatalogEntry[], opts: TemplateVerifyOptions = {}): string[] {
  const problems: string[] = [];
  const byValue = new Map(templates.map(t => [t.value, t]));
  for (const node of nodes) {
    if (node.type !== 'template') continue;
    const value = String(node.config?.templateId ?? '').trim();
    if (!value) continue;                        // unset is allowed — the user picks in the panel
    if (!value.startsWith('carousel:')) continue; // non-carousel (reel) values are the user's own panel
                                                  // choice — the runtime rejects them; not the model's to fix
    const tpl = byValue.get(value);
    if (!tpl && (opts.preexisting?.has(value) || opts.truncated)) continue; // user's own / unknowable — never flag
    if (!tpl) {
      const list = templates.slice(0, 12).map(t => `"${t.value}" (${t.name})`).join(', ') || '(the user has no templates)';
      problems.push(`Template node "${displayLabel(node)}" has templateId "${value}", which is not one of the user's templates. Valid values: ${list}. Use an exact value or leave templateId unset.`);
      continue;
    }
    const bindings = (node.config?.bindings && typeof node.config.bindings === 'object' ? node.config.bindings : {}) as Record<string, string>;
    const keys = Object.keys(bindings);
    const unknown = keys.filter(k => !k.startsWith('el:') && !k.startsWith('bg:') && !tpl.placeholders.includes(k));
    if (unknown.length) {
      problems.push(`Template node "${displayLabel(node)}" binds placeholder(s) ${unknown.map(k => `{${k}}`).join(', ')} that don't exist in "${tpl.name}". Its real placeholders are: ${tpl.placeholders.map(p => `{${p}}`).join(', ') || '(none)'}.`);
    }
    // bg:<slideId> keys must reference the template's REAL slides (when the catalog carries them).
    if (tpl.bgKeys) {
      const badBg = keys.filter(k => k.startsWith('bg:') && !tpl.bgKeys!.includes(k));
      if (badBg.length) {
        problems.push(`Template node "${displayLabel(node)}" binds slide background(s) ${badBg.join(', ')} that don't exist in "${tpl.name}". Its real slide-background keys are: ${tpl.bgKeys.join(', ') || '(none)'}.`);
      }
    }
  }
  return problems;
}
