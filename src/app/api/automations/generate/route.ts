import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { geminiChat, parseJson, GeminiError, BudgetError, COPILOT_MODEL, type ChatMessage } from '@/lib/gemini';
import { NODE_DESCRIPTORS, DESCRIPTOR_LIST, instantiate } from '@/lib/automations/descriptors';
import { defaultConfig } from '@/lib/automations/params';
import { canConnect, type Edge, type FlowNode, type Graph } from '@/lib/automations';
import { topoSort } from '@/lib/automations/graph';
import { extractPlaceholders, collectStrings } from '@/lib/automations/mapping';
import { serverNodeRegistry } from '@/lib/automations/serverNodes';
import { buildRunServices } from '@/lib/automations/serverContext';
import {
  verifyGeneratedCodeNodes, ungroundedHttpUpstreams, verifyMappings, verifyTemplateConfig,
  type TemplateCatalogEntry,
} from '@/lib/automations/verifyGenerated';
import { isElementCodeSafe } from '@/lib/customElements/codeGuards';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
// Verification may re-ask the model (≤2×) and live-probe GET sources (≤3 × 15s) — give it headroom.
export const maxDuration = 180;

// Conversational chat → flow (§7.2), Lovable/v0 style. The panel sends the running conversation plus the
// current graph; the model returns the FULL desired graph (nodes + index-based edges) and a one-line
// summary of what it did. We materialise ids/ports/positions and validate every edge, so a hallucinated
// type or port can never reach the canvas. Nodes the model keeps (echoing their id) retain their
// position, config and identity — an AI edit must not bulldoze the user's canvas.

function catalog(): string {
  // The chat builder never wires a Post node (publishing is the user's choice) nor an Element node (it
  // needs a saved element picked in the panel) — both are preserved automatically when they exist.
  return DESCRIPTOR_LIST.filter(d => d.type !== 'post' && d.type !== 'element').map(d => {
    const ports = (ps: Array<{ id: string; dataType: string }>) => ps.map(p => `${p.id}:${p.dataType}`).join(', ') || '—';
    const params = d.parameters.filter(p => p.type !== 'notice').map(p => {
      const bits: string[] = [`${p.name}: ${p.type}`];
      if (p.options?.length) bits.push(`one of [${p.options.map(o => JSON.stringify(o.value)).join('|')}]`);
      if (p.default !== undefined) bits.push(`default=${JSON.stringify(p.default)}`);
      if (p.required) bits.push('REQUIRED');
      const show = p.displayOptions?.show;
      if (show) bits.push(`(applies when ${Object.entries(show).map(([k, v]) => `${k}=${v.join('|')}`).join(' & ')})`);
      return `      ${bits.join(' ')}${p.description ? ` — ${p.description}` : ''}`;
    }).join('\n');
    return `- ${d.type} (${d.group}) "${d.label}"${d.description ? ` — ${d.description}` : ''}\n    ports: inputs[${ports(d.inputs)}] outputs[${ports(d.outputs)}]\n    config params:\n${params || '      (none)'}`;
  }).join('\n');
}

interface FlowElement { feId: string; name: string; inputs: Array<{ key: string }>; code: string }
interface RunRow { id?: string; label?: string; received?: unknown; output?: unknown; outputItems?: number; error?: string; stale?: boolean }
interface UserFlowContext { templates: TemplateCatalogEntry[]; templatesTruncated: boolean; credentials: Array<{ id: string; label: string; kind: string }> }

const TEMPLATE_CATALOG_CAP = 100;

// The user's templates (with their real {placeholders}) and stored credential metadata — without these
// the model can never fill templateId/credentialId and every build ends "pick a template yourself".
async function fetchUserFlowContext(userId: string): Promise<UserFlowContext> {
  const db = supabaseAdmin();
  const [caro, creds] = await Promise.all([
    db.from('template_editor_templates').select('id,name').eq('user_id', userId).order('position', { ascending: true }).limit(TEMPLATE_CATALOG_CAP),
    db.from('automation_credentials').select('id,label,kind').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
  ]);
  const templates: TemplateCatalogEntry[] = [];
  const caroRows = (caro.data ?? []) as Array<{ id: string; name: string }>;
  if (caroRows.length) {
    // NB: `settings` is a CLIENT-side aggregate (rowToSlide) — the table stores individual columns;
    // {placeholders} live in headline/subheadline and the text_boxes JSONB.
    const { data: slides } = await db.from('template_editor_slides')
      .select('id,template_id,headline,subheadline,text_boxes').in('template_id', caroRows.map(r => r.id)).order('position', { ascending: true });
    const phByTpl = new Map<string, Set<string>>();
    const bgByTpl = new Map<string, string[]>();
    for (const s of (slides ?? []) as Array<{ id: string; template_id: string; headline?: string; subheadline?: string; text_boxes?: unknown }>) {
      const set = phByTpl.get(s.template_id) ?? new Set<string>();
      for (const text of [s.headline ?? '', s.subheadline ?? '', ...collectStrings(s.text_boxes)]) {
        for (const ph of extractPlaceholders(text)) set.add(ph);
      }
      phByTpl.set(s.template_id, set);
      bgByTpl.set(s.template_id, [...(bgByTpl.get(s.template_id) ?? []), `bg:${s.id}`]);
    }
    for (const r of caroRows) templates.push({ value: `carousel:${r.id}`, name: r.name, placeholders: [...(phByTpl.get(r.id) ?? [])], bgKeys: bgByTpl.get(r.id) ?? [] });
  }
  return {
    templates,
    templatesTruncated: caroRows.length >= TEMPLATE_CATALOG_CAP,
    credentials: (creds.data ?? []) as Array<{ id: string; label: string; kind: string }>,
  };
}

const clip = (v: unknown, max: number): string => {
  let s: string;
  try { s = JSON.stringify(v ?? null) ?? 'null'; } catch { return '(unserialisable)'; }
  return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
};

/**
 * One structured entry per node, in execution (topological) order — the model's entire picture of the
 * canvas. Each node carries its identity, config, connections AND its last-run data in one place, so
 * tracing data hop-by-hop never needs to cross-reference two separate blobs.
 */
function flowView(graph: Graph | undefined, runRows: RunRow[]): string {
  const nodes = graph?.nodes ?? [];
  if (!nodes.length) return '(empty canvas)';
  const edges = graph?.edges ?? [];
  let order: string[];
  try { order = topoSort(graph!); } catch { order = nodes.map(n => n.id); }
  const byId = new Map(nodes.map(n => [n.id, n]));

  // Match run rows to nodes: by id when the client sent ids, else by the client's label derivation.
  const rowById = new Map<string, RunRow>();
  const rowByLabel = new Map<string, RunRow>();
  for (const r of runRows) {
    if (r.id && !rowById.has(r.id)) rowById.set(r.id, r);
    if (r.label && !rowByLabel.has(r.label)) rowByLabel.set(r.label, r);
  }

  const lines: string[] = [];
  let budget = 40_000;
  const push = (s: string) => { if (budget > 0) { lines.push(s); budget -= s.length; } };
  for (const id of order) {
    const n = byId.get(id);
    if (!n) continue;
    const ins = edges.filter(e => e.to.node === id).map(e => `${e.from.node}.${e.from.port} → ${e.to.port}`).join(', ');
    const outs = edges.filter(e => e.from.node === id).map(e => `${e.from.port} → ${e.to.node}.${e.to.port}`).join(', ');
    push(`NODE ${id} (${n.type})${n.label ? ` label=${JSON.stringify(n.label)}` : ''}`);
    push(`  config: ${clip(n.config ?? {}, 700)}`);
    push(`  in:  ${ins || '(nothing connected)'}`);
    push(`  out: ${outs || '(nothing connected)'}`);
    const row = rowById.get(id) ?? rowByLabel.get(n.label ?? n.type);
    if (row) {
      if (typeof row.error === 'string' && row.error.trim()) {
        push(`  last run: ${row.received !== undefined ? `received ${clip(row.received, 1_200)} → ` : ''}FAILED: ${row.error.slice(0, 500)}`);
      } else {
        const rec = row.received !== undefined ? `received ${clip(row.received, 1_200)}` : '';
        // A fan-out is invisible from the sample alone — item 1 of 40 looks identical to a single
        // item, and downstream nodes run once PER item. Say so explicitly.
        const fanOut = typeof row.outputItems === 'number' && row.outputItems > 1
          ? ` (item 1 of ${row.outputItems} — this node FANNED OUT into ${row.outputItems} items; each downstream node runs once per item, e.g. a template renders one post per item. For one-pass data like a chart series, the upstream must return an object holding the array, not a bare array.)`
          : '';
        const emit = row.output !== undefined ? `emitted ${clip(row.output, 1_200)}${fanOut}` : '(did not run)';
        push(`  last run: ${rec ? `${rec} → ` : ''}${emit}`);
      }
    }
  }
  if (budget <= 0) lines.push('…(more omitted — flow too large to show in full)');
  const stale = runRows.some(r => r?.stale)
    ? '\n(NOTE: "last run" values predate the latest edit(s) — node config in the flow may already differ, but the data shapes are real.)'
    : '';
  return lines.join('\n') + stale;
}

function system(flowViewText: string, elements: FlowElement[], userCtx: UserFlowContext, hasRunData: boolean): string {
  const templates = userCtx.templates.length
    ? userCtx.templates.map(t => `- templateId ${JSON.stringify(t.value)} — ${JSON.stringify(t.name)} · placeholders: ${t.placeholders.map(p => `{${p}}`).join(', ') || '(none)'}${t.bgKeys?.length ? ` · slide backgrounds (bind an IMAGE URL): ${t.bgKeys.join(', ')}` : ''}`).join('\n')
    : '(the user has no carousel templates yet — build the flow with the template node\'s templateId left unset, and tell them in "summary" to create a template first)';
  const credentials = userCtx.credentials.length
    ? userCtx.credentials.map(c => `- credentialId ${JSON.stringify(c.id)} — ${JSON.stringify(c.label)} (${c.kind})`).join('\n')
    : '(none stored yet — if an API needs a key, build the http node with authentication="apiKey" and no credentialId; the user attaches the key in the panel)';
  return `You are the FeedForce automation copilot — a friendly assistant that designs and EDITS a node
graph through conversation, and chats normally when the user isn't asking for a change.
Use ONLY these node types, with their exact port ids and config param names:
${catalog()}

THE USER'S TEMPLATES — the ONLY valid values for a template node's templateId (only carousel templates
can be applied):
${templates}
Template bindings: a template node's config may include "bindings" — { "<placeholder>": "<dot.path>" } —
mapping each {placeholder} to a path in the data arriving on its "data" input (resolved exactly like a
code node's ctx.input). Keys may also be a listed "bg:<slideId>" — the path must then resolve to an
IMAGE URL (http/https), which becomes that slide's background image. Set bindings ONLY when the flow
view's real last-run data (or a code node you wrote, whose returned field names you know) tells you the
true shape; otherwise leave bindings out and the user maps them in the panel.

THE USER'S STORED CREDENTIALS — the ONLY valid values for an http node's credentialId:
${credentials}

THE CURRENT FLOW — one entry per node in execution order. "in"/"out" show its connections
(nodeId.port → port). "last run" is REAL data from the user's most recent run: what the node RECEIVED
on its input — exactly what a code node's ctx.input and a template's bindings see, envelopes already
unwrapped — and what it EMITTED (its raw output; source nodes wrap theirs in { status, ok, data },
which the runtime strips before the next node sees it).
${flowViewText}
${hasRunData ? `Trace the data hop by hop and find the FIRST node whose emitted output is wrong or empty GIVEN what it
received — that node is the one to fix. Never guess a data shape these values contradict, and never
re-unwrap what is already unwrapped. A trigger emitting {} is NORMAL (triggers fire the run; they carry
no data) — an empty trigger output is never the problem.` : ''}

When the user asks for a change, return the FULL updated flow (not a diff — every node, including the
unchanged ones). Return ONLY JSON:
{
  "summary": "one short sentence describing what you built or changed",
  "nodes": [{ "id": "n2", "type": "http", "label": "optional", "config": { } }],
  "edges": [{ "from": { "node": 0, "port": "out" }, "to": { "node": 1, "port": "in" } }]
}
"id": when a node in your output IS one of the current flow's nodes (kept as-is or edited), copy that
node's id from the flow view — this preserves its position on the canvas, its run data and its wiring
to the user's Post node. OMIT id for brand-new nodes and NEVER invent ids. On a kept node, OMIT
"config" entirely to keep its config unchanged; when you DO send "config" it is the node's FULL new
config — any key you leave out is removed (that's how you delete a binding or an API key). "node" in
an edge is the INDEX into your nodes array (never an id). Wire output ports to sensible input ports. Start with a
trigger and end with a Template node. NEVER include a Post or Element node in your output — those are
the user's own and are re-attached automatically (another reason to keep ids stable). Keep it under 8
nodes. Fill node config where you can (url, templateId, credentialId — from the lists above only).

CONVERSATION — not every message is a change request. If the user greets you, asks a question (what
does this flow do? what can you build?), or says something that isn't an edit, do NOT invent or rebuild
a flow. Return ONLY:
{ "reply": "your short, warm, conversational answer" }
Answer questions about the current flow from the flow view above. If an edit request is too ambiguous
to act on, ask ONE clarifying question in "reply" instead of guessing. When the intent IS a change,
even loosely worded, prefer making the change over asking.
A bare {"reply"} changes NOTHING on the canvas. NEVER use it to say you fixed/updated/changed something —
if your reply would claim a change, you MUST instead return the full flow JSON with that change actually
applied (and put the claim in "summary").

CRITICAL RULE — never use the AI node to write the slide's text or compose the post. The slide content
is REAL DATA meshed into the chosen template's {placeholders} via the Template node's field bindings —
e.g. bind an HTTP node's "name"/"price" output straight into the template. Use the AI node ONLY to
process or derive data (classify, extract, pick the top item, compute a value), never to author
headlines/captions/marketing copy. If the goal is just "post data on a template", wire the data source
directly into the Template node with NO AI node in between.

CODE NODE CONTRACT — if you set a code node's "code", it MUST be \`export default function run(ctx) { … }\`
(or \`function run(ctx) {}\`). ctx.input is the upstream data already parsed AND already unwrapped: source
nodes emit a { status, ok, data } envelope and the runtime STRIPS it before the code runs, so ctx.input IS
the inner data (for an HTTP node: the response body itself — if the API returns a JSON array, ctx.input is
that array). NEVER read ctx.input.data, never JSON.parse, and even if a run log shows the { status, ok,
data } wrapper, the code never sees it. With ONE upstream node ctx.input is that node's data directly — the
keyed-by-label form (ctx.input["Some Label"]) exists ONLY when 2+ nodes fan into the same input port.
ctx.inputs.<port> is the raw items array. Return a plain object of output fields, e.g.
\`return { name: top.name, price: top.current_price };\`. Keep it synchronous.

HTTP URL MAPPING — an http node's url may embed values from its own upstream input with {{ path }}, e.g.
https://api.coingecko.com/api/v3/coins/{{input.id}}/market_chart?vs_currency=usd&days=7. Paths resolve
against the node's input exactly like a code node's ctx.input ({{id}} and {{input.id}} both work; values
are URL-encoded). Use this to CHAIN requests: source A → code node picks the id → http B uses {{id}}.

FAN-IN — several nodes may connect into ONE input: the downstream node runs only after ALL of them
finish. With 2+ sources, the combined input is an object keyed by each source node's label (duplicate
labels get " 2", " 3"…): a code node reads ctx.input["Coin prices"], and Template/AI bindings address
paths like "Coin prices.bitcoin.gbp". Give nodes short distinct labels when you wire fan-in. Use this
instead of chaining when a template needs values from independent sources.${
  elements.length ? `

This flow's templates contain these CUSTOM ELEMENTS (charts/tables/etc.) that you can also MODIFY:
${elements.map(e => `- feId "${e.feId}" — ${e.name} (inputs: ${e.inputs.map(i => i.key).join(', ') || 'none'})\n  current code:\n${e.code}`).join('\n\n')}

If the user asks to change a chart / table / element / component (e.g. "make the bars thinner", "add
gridlines", "use the accent colour"), DO NOT change the flow — instead return ONLY:
{ "summary": "what you changed", "elementEdits": [{ "feId": "<the element's feId>", "code": "<the FULL new draw-function body>" }] }
The code is the BODY of (ctx, props) => void: draw relative to props.width/height, read all data from
props.data, animate with props.progress (0..1), theme via props.theme. Pure 2D canvas only — no window,
document, fetch, import, require, eval, or timers. Otherwise, build/edit the node graph as above.` : ''
}`;
}

interface GenNode { id?: string; type?: string; label?: string; config?: Record<string, unknown> }
interface GenEdge { from?: { node?: number; port?: string }; to?: { node?: number; port?: string } }
interface GenResult { summary?: string; reply?: string; nodes?: GenNode[]; edges?: GenEdge[]; elementEdits?: Array<{ feId?: string; code?: string }> }
interface Materialized { nodes: FlowNode[]; edges: Edge[]; problems: string[] }

/**
 * Materialise the model's flow against the CURRENT graph: a node echoing an existing id (same type)
 * keeps that node's identity, position and unmentioned config; unknown types and invalid edges become
 * PROBLEMS (fed back to the model) instead of silent drops; the user's Post/Element nodes — which the
 * model must never emit — are re-attached along with any of their edges whose endpoints survived.
 */
function materialize(raw: GenResult, current: Graph | undefined): Materialized {
  const problems: string[] = [];
  const existingById = new Map((current?.nodes ?? []).map(n => [n.id, n]));
  const usedIds = new Set<string>();
  const nodes: FlowNode[] = [];
  const indexToNode = new Map<number, FlowNode>();
  let seq = 0;
  const freshId = () => {
    let id;
    do { id = `n${++seq}`; } while (usedIds.has(id) || existingById.has(id));
    return id;
  };

  (raw.nodes ?? []).forEach((n, i) => {
    if (n.type === 'post' || n.type === 'element') return; // never model-authored; re-attached below
    if (!n.type || !NODE_DESCRIPTORS[n.type]) {
      problems.push(`nodes[${i}] has unknown type ${JSON.stringify(n.type ?? null)} — use only the catalog's node types.`);
      return;
    }
    const echoed = n.id ? existingById.get(String(n.id)) : undefined;
    let node: FlowNode;
    if (echoed && echoed.type === n.type && !usedIds.has(echoed.id)) {
      // Config semantics for a kept node: OMITTED config = keep the node's config unchanged; PROVIDED
      // config = the full desired config (defaults + exactly the model's keys). Never merge the model's
      // config over the old one — that would make removing a key (bindings, an API key…) impossible.
      const provided = n.config && typeof n.config === 'object';
      node = {
        ...echoed,
        inputs: echoed.inputs.map(p => ({ ...p })),
        outputs: echoed.outputs.map(p => ({ ...p })),
        config: provided
          ? { ...defaultConfig(NODE_DESCRIPTORS[n.type].parameters), ...n.config }
          : { ...echoed.config },
        ...(n.label ? { label: String(n.label) } : {}),
      };
    } else {
      if (n.id && !echoed) problems.push(`nodes[${i}] claims id ${JSON.stringify(n.id)}, which is not in the current flow — omit "id" for new nodes.`);
      if (echoed && echoed.type !== n.type) problems.push(`nodes[${i}] claims id ${JSON.stringify(n.id)} but changes its type (${echoed.type} → ${n.type}) — a kept id must keep its type; omit "id" to add a new node.`);
      node = instantiate(n.type, freshId(), 0, 0) as FlowNode;
      if (n.label) node.label = String(n.label);
      if (n.config && typeof n.config === 'object') node.config = { ...node.config, ...n.config };
    }
    usedIds.add(node.id);
    nodes.push(node);
    indexToNode.set(i, node);
  });

  // Position new nodes in a row that doesn't sit on top of kept ones.
  const kept = nodes.filter(n => existingById.has(n.id));
  const baseY = kept.length ? Math.max(...kept.map(n => n.y ?? 0)) + 200 : 120;
  let col = 0;
  for (const n of nodes) {
    if (existingById.has(n.id)) continue;
    n.x = 80 + col * 260;
    n.y = kept.length ? baseY : 120;
    col++;
  }

  const edges: Edge[] = [];
  (raw.edges ?? []).forEach((e, k) => {
    const from = e.from?.node != null ? indexToNode.get(e.from.node) : undefined;
    const to = e.to?.node != null ? indexToNode.get(e.to.node) : undefined;
    if (!from || !to || !e.from?.port || !e.to?.port) {
      problems.push(`edges[${k}] references a node index that doesn't exist in your nodes array (or lacks a port) — edges use array INDEXES.`);
      return;
    }
    const op = from.outputs.find(p => p.id === e.from!.port);
    const ip = to.inputs.find(p => p.id === e.to!.port);
    if (!op || !ip) {
      problems.push(`edges[${k}] (${from.type} → ${to.type}) uses port "${!op ? e.from.port : e.to.port}" which doesn't exist — valid output ports of ${from.type}: [${from.outputs.map(p => p.id).join(', ')}]; valid input ports of ${to.type}: [${to.inputs.map(p => p.id).join(', ')}].`);
      return;
    }
    if (!canConnect(op.dataType, ip.dataType)) {
      problems.push(`edges[${k}] connects incompatible port types (${from.type}.${op.id}:${op.dataType} → ${to.type}.${ip.id}:${ip.dataType}).`);
      return;
    }
    const id = `${from.id}.${op.id}->${to.id}.${ip.id}`;
    if (!edges.some(x => x.id === id)) edges.push({ id, from: { node: from.id, port: op.id }, to: { node: to.id, port: ip.id } });
  });

  // Re-attach the user's Post/Element nodes and whatever of their wiring still has both endpoints.
  for (const n of current?.nodes ?? []) {
    if ((n.type !== 'post' && n.type !== 'element') || usedIds.has(n.id) || nodes.length === 0) continue;
    nodes.push({ ...n, inputs: n.inputs.map(p => ({ ...p })), outputs: n.outputs.map(p => ({ ...p })), config: { ...n.config } });
    usedIds.add(n.id);
  }
  for (const e of current?.edges ?? []) {
    const touchesKept = [e.from.node, e.to.node].some(id => {
      const n = nodes.find(x => x.id === id);
      return n && (n.type === 'post' || n.type === 'element');
    });
    if (!touchesKept) continue;
    const from = nodes.find(x => x.id === e.from.node);
    const to = nodes.find(x => x.id === e.to.node);
    if (!from || !to) continue;
    if (!from.outputs.some(p => p.id === e.from.port) || !to.inputs.some(p => p.id === e.to.port)) continue;
    if (!edges.some(x => x.id === e.id) && !edges.some(x => x.from.node === e.from.node && x.from.port === e.from.port && x.to.node === e.to.node && x.to.port === e.to.port)) {
      edges.push({ ...e, from: { ...e.from }, to: { ...e.to } });
    }
  }

  // Structural sanity the model must fix: a flow with nodes needs a trigger, and every node with input
  // ports must actually be fed (a disconnected node LOOKS built but silently never receives data).
  if (nodes.length > 0 && !nodes.some(n => n.type === 'trigger')) {
    problems.push('The flow has no trigger node — every flow starts with one.');
  }
  for (const n of nodes) {
    if (n.type === 'post' || n.type === 'element') continue; // user-managed; may be legitimately unwired
    if (n.inputs.length > 0 && !edges.some(e => e.to.node === n.id)) {
      problems.push(`Node "${n.label ?? n.id}" (${n.type}) has no incoming connection — wire something into it or remove it.`);
    }
  }

  return { nodes, edges, problems };
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  // 10/min: this lane now serves cheap conversational turns too (greetings, questions, clarifications),
  // not just graph generation — 3/min would 429 a normal back-and-forth. Spend stays bounded by the
  // size caps below + the per-user monthly AI budget.
  if (!(await rateLimit('automations:generate:' + user.id, 10))) return tooManyRequests();

  const { messages, graph, elements, runOutputs } = (await req.json().catch(() => ({}))) as {
    messages?: ChatMessage[]; graph?: Graph; elements?: FlowElement[]; runOutputs?: RunRow[];
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Say what the automation should do.' }, { status: 400 });
  }
  // Size caps — everything below lands in a metered LLM prompt, so a caller must not be able to pump
  // megabytes through it (cost abuse / DoS). Limits sit far above anything the UI can produce.
  if (messages.some(m => typeof m?.content === 'string' && m.content.length > 10_000)) {
    return NextResponse.json({ error: 'Message too long.' }, { status: 400 });
  }
  if ((graph?.nodes?.length ?? 0) > 60 || JSON.stringify(graph ?? {}).length > 200_000) {
    return NextResponse.json({ error: 'Flow too large to edit with AI.' }, { status: 400 });
  }
  const flowElements: FlowElement[] = Array.isArray(elements)
    ? elements.filter(e => e && typeof e.feId === 'string' && typeof e.code === 'string' && e.code.length <= 50_000).slice(0, 12)
    : [];
  const runRows: RunRow[] = (Array.isArray(runOutputs) ? runOutputs.slice(0, 24) : [])
    .filter((r): r is RunRow => !!r && (typeof r.label === 'string' || typeof r.id === 'string'))
    .map(r => ({ ...r, id: typeof r.id === 'string' ? r.id.slice(0, 40) : undefined, label: typeof r.label === 'string' ? r.label.slice(0, 80) : undefined }));

  // Executes a generated code node in the SAME vm sandbox real runs use. The input is pre-wrapped in a
  // { data } envelope so the engine's unwrap hands the code exactly `input` as ctx.input.
  const runGeneratedCode = async (code: string, input: unknown) => {
    const res = await serverNodeRegistry.code.run({ config: { code }, inputs: { in: [{ json: { data: input } as Record<string, unknown> }] } });
    return res.out ?? [];
  };

  try {
    const userCtx = await fetchUserFlowContext(user.id);
    const view = flowView(graph, runRows);
    const sys = system(view, flowElements, userCtx, runRows.length > 0);
    // COPILOT_MODEL, not the default tier: flash-lite truncates structured JSON often enough to matter
    // (see gemini.ts's model notes) and this route's whole output is one JSON document.
    const opts = { json: true, temperature: 0.2, model: COPILOT_MODEL, maxOutputTokens: flowElements.length ? 24000 : undefined, userId: user.id };
    let convo: ChatMessage[] = messages.slice(-12);
    let text = await geminiChat([{ role: 'system', content: sys }, ...convo], opts);
    let raw = parseJson<GenResult>(text);

    // Element edit (chart/table change) → validate the code + return the edits, no graph change.
    if (Array.isArray(raw.elementEdits) && raw.elementEdits.length) {
      const edits = raw.elementEdits
        .filter(e => e && typeof e.feId === 'string' && typeof e.code === 'string' && e.code.trim() && isElementCodeSafe(e.code))
        .map(e => ({ feId: e.feId as string, code: (e.code as string).trim() }));
      if (edits.length) return NextResponse.json({ elementEdits: edits, summary: (raw.summary && String(raw.summary).trim()) || 'Updated the element.' });
    }

    let { nodes, edges, problems: structural } = materialize(raw, graph);

    // ── Verification loop ── the model's flow is not taken on faith. Structural problems (unknown
    // types, invalid edges, disconnected nodes), template-config problems (templateId/bindings checked
    // against the user's REAL templates), {{ }} mapping problems (paths resolved against real samples)
    // and code problems (the code EXECUTED in the sandbox against the last run's real data) all go back
    // to the model as an automated correction turn (up to 2 re-asks), so a provably broken "fix" can't
    // reach the canvas silently.
    let problems: string[] = [];
    const attempted = (raw.nodes?.length ?? 0) > 0;
    if (attempted) {
      const emitted = new Map<string, unknown>();
      for (const r of runRows) {
        if (r.output === undefined) continue;
        if (r.id) emitted.set(`id:${r.id}`, r.output);
        if (r.label && !emitted.has(r.label)) emitted.set(r.label, r.output);
      }
      // Step-by-step grounding for revisions: a code node's HTTP source with no last-run data (fresh
      // build, edited URL, or run state cleared by a previous apply) is probed LIVE — GET only, through
      // runHttp's SSRF guard + 15s timeout — so the code is always verified against the source's real
      // current response shape, never written blind. Re-runs each retry (the model may change the URL).
      let liveProbes = 0;
      const services = buildRunServices(user.id);
      const groundSources = async (ns: FlowNode[], es: Edge[]) => {
        for (const up of ungroundedHttpUpstreams(ns, es, emitted)) {
          const method = String(up.config?.method ?? 'GET').toUpperCase();
          const urlStr = String(up.config?.url ?? '');
          // {{ }}-templated urls need flow data to resolve — probing them blind would ground the
          // verification on a bogus 404 and wrongly fail good code.
          if (method !== 'GET' || !/^https?:\/\//i.test(urlStr) || urlStr.includes('{{') || liveProbes >= 3) continue;
          liveProbes++;
          try {
            const res = await serverNodeRegistry.http.run({ config: up.config ?? {}, inputs: {}, userId: user.id, services });
            const json = res.out?.[0]?.json;
            if (json !== undefined) {
              emitted.set(`id:${up.id}`, json);
              if (up.label) emitted.set(up.label, json);
            }
          } catch { /* unreachable source — verification proceeds without this grounding */ }
        }
      };
      // A templateId the CURRENT graph already carries is the user's own choice — never flag it, even
      // when it sits outside the capped catalog (e.g. template #101+).
      const preexisting = new Set(
        (graph?.nodes ?? []).filter(n => n.type === 'template').map(n => String(n.config?.templateId ?? '').trim()).filter(Boolean),
      );
      const verifyAll = async (ns: FlowNode[], es: Edge[]): Promise<string[]> => {
        await groundSources(ns, es);
        return [
          ...verifyTemplateConfig(ns, userCtx.templates, { preexisting, truncated: userCtx.templatesTruncated }),
          ...verifyMappings(ns, es, emitted),
          ...await verifyGeneratedCodeNodes(ns, es, emitted, runGeneratedCode),
        ];
      };
      problems = structural.concat(await verifyAll(nodes, edges));
      for (let attempt = 0; problems.length > 0 && attempt < 2; attempt++) {
        convo = [
          ...convo,
          { role: 'assistant' as const, content: text },
          { role: 'user' as const, content: `AUTOMATED VERIFICATION (not the user): I checked your flow against the user's real templates and the flow's REAL run data, and found these problems:\n${problems.map(p => `- ${p}`).join('\n')}\nReturn the FULL corrected flow JSON (same format, all nodes + edges, keeping existing node ids). Fix every problem — do not repeat the same output.` },
        ].slice(-16);
        text = await geminiChat([{ role: 'system', content: sys }, ...convo], opts);
        try {
          const retry = parseJson<GenResult>(text);
          const m = materialize(retry, graph);
          if (m.nodes.length > 0) { raw = retry; nodes = m.nodes; edges = m.edges; structural = m.problems; }
        } catch { break; } // garbled retry — keep the previous graph; the warning below surfaces it
        problems = structural.concat(await verifyAll(nodes, edges));
      }
    }
    const verifyWarning = problems.length > 0
      ? ' ⚠ I checked the flow against your real templates and run data and some issues remain — review the flagged nodes before running.'
      : '';

    // Conversational turn (greeting / question / clarification) → no canvas change, just the reply.
    const chatReply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
    if (nodes.length === 0) {
      if (chatReply) return NextResponse.json({ reply: chatReply });
      return NextResponse.json({ error: 'I couldn’t turn that into a flow — try rephrasing.' }, { status: 400 });
    }
    const reply = ((raw.summary && String(raw.summary).trim()) || `Built a ${nodes.length}-node flow.`) + verifyWarning;
    return NextResponse.json({ graph: { nodes, edges }, summary: reply });
  } catch (e) {
    if (e instanceof GeminiError) {
      // Same policy as the agent route: swap raw vendor load-shedding bodies (5xx / non-budget 429,
      // e.g. Google's "high demand" text) for our own copy; our own errors keep their messages.
      const vendorBusy = e.status >= 500 || (e.status === 429 && !(e instanceof BudgetError));
      const message = vendorBusy
        ? 'The AI service is busy right now — give it a minute and try again.'
        : e.message;
      return NextResponse.json({ error: message }, { status: e.status });
    }
    console.error('[automations/generate]', e);
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
  }
}
