import type { Port } from './types';
import type { NodeParam } from './params';
import { defaultConfig } from './params';

// Editor-side node descriptors: label, group, icon key, ports, and the config-panel parameters.
// Phase 1 ships a starter set with static ports; later phases generate ports dynamically (HTTP from
// docs, AI from output schema, Template from identifiers) and attach executable `run()` definitions.

export type NodeGroup = 'Trigger' | 'Source' | 'Logic' | 'Transform' | 'Render' | 'Output';

export interface NodeDescriptor {
  type: string;
  label: string;
  group: NodeGroup;
  icon: string;            // key → resolved to an SVG in the UI (nodeIcons.tsx)
  description?: string;
  inputs: Port[];
  outputs: Port[];
  parameters: NodeParam[];
}

const port = (id: string, name: string, dataType: Port['dataType']): Port => ({ id, name, dataType });

// Error-policy params shared by the nodes that talk to flaky externals (http/ai) or run authored code.
// The engine reads these off config (engine.ts errorPolicy) — retry is bounded, continue emits { error }.
const ERROR_POLICY_PARAMS: NodeParam[] = [
  { name: 'retryOnFail', displayName: 'Retry on fail', type: 'boolean', default: false,
    description: 'Re-attempt this node (with a short wait) before treating it as failed.' },
  { name: 'maxTries', displayName: 'Max tries', type: 'options', default: 3,
    options: [2, 3, 4, 5].map(n => ({ name: String(n), value: n })),
    displayOptions: { show: { retryOnFail: [true] } } },
  { name: 'continueOnFail', displayName: 'Continue on fail', type: 'boolean', default: false,
    description: 'On failure, emit { error } and keep the run going instead of stopping the whole flow.' },
];

// The http variant hides retry for write methods — the engine refuses those retries anyway (a timed-out
// POST may already have applied remotely; re-sending duplicates the write), so the panel shouldn't offer it.
const HTTP_ERROR_POLICY_PARAMS: NodeParam[] = ERROR_POLICY_PARAMS.map(p =>
  p.name === 'retryOnFail' || p.name === 'maxTries'
    ? { ...p, displayOptions: { ...p.displayOptions, hide: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } } }
    : p,
);

export const NODE_DESCRIPTORS: Record<string, NodeDescriptor> = {
  trigger: {
    type: 'trigger', label: 'Timer/schedule', group: 'Trigger', icon: 'clock',
    description: 'Starts the flow — run it manually, or on a timer.',
    inputs: [], outputs: [port('out', 'Out', 'any')],
    parameters: [
      { name: 'mode', displayName: 'Trigger', type: 'options', default: 'manual', noDataExpression: true,
        options: [{ name: 'Manual (Run button)', value: 'manual' }, { name: 'Timer / schedule', value: 'timer' }] },
      { name: 'interval', displayName: 'Interval', type: 'options', default: 'daily',
        options: [{ name: 'Hourly', value: 'hourly' }, { name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }, { name: 'Custom (cron)', value: 'cron' }],
        displayOptions: { show: { mode: ['timer'] } } },
      { name: 'cron', displayName: 'Cron expression', type: 'string', default: '0 9 * * *', placeholder: '0 9 * * *',
        description: 'Standard 5-field cron: minute hour day-of-month month day-of-week.',
        displayOptions: { show: { mode: ['timer'], interval: ['cron'] } } },
      { name: 'tz', displayName: 'Timezone', type: 'string', default: 'UTC', placeholder: 'Europe/London',
        description: 'IANA timezone the cron expression is evaluated in.',
        displayOptions: { show: { mode: ['timer'], interval: ['cron'] } } },
    ],
  },
  http: {
    type: 'http', label: 'HTTP request', group: 'Source', icon: 'globe',
    description: 'Call any API. (Phase 2: generate this from pasted docs.)',
    inputs: [port('in', 'In', 'any')], outputs: [port('out', 'Response', 'object')],
    parameters: [
      { name: 'method', displayName: 'Method', type: 'options', default: 'GET', noDataExpression: true,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => ({ name: m, value: m })) },
      { name: 'url', displayName: 'URL', type: 'string', required: true, placeholder: 'https://api.example.com/v1/...',
        description: 'Supports {{ }} data mapping from the previous node, e.g. …/coins/{{input.id}}/chart — values are URL-encoded. (Templated URLs need flow data: use Run flow, not the single-node test.)' },
      { name: 'authentication', displayName: 'Authentication', type: 'options', default: 'none',
        options: [{ name: 'None', value: 'none' }, { name: 'API key', value: 'apiKey' }] },
      { name: 'credentialId', displayName: 'API key', type: 'credential',
        description: 'Stored encrypted server-side — only its id is saved in the flow.',
        displayOptions: { show: { authentication: ['apiKey'] } } },
      { name: 'sendBody', displayName: 'Send body', type: 'boolean', default: false,
        displayOptions: { show: { method: ['POST', 'PUT', 'PATCH'] } } },
      { name: 'body', displayName: 'Body (JSON)', type: 'json', typeOptions: { editor: 'json' },
        displayOptions: { show: { sendBody: [true] } } },
      ...HTTP_ERROR_POLICY_PARAMS,
    ],
  },
  ai: {
    type: 'ai', label: 'Custom agent', group: 'Source', icon: 'sparkles',
    description: 'An AI step for working with data — classify, extract, summarise or derive values from upstream data via a prompt + a user-defined output schema (its output ports). It does NOT write the slide copy or compose the post: slide text is real data meshed into your template.',
    inputs: [port('in', 'In', 'any')], outputs: [port('out', 'Output', 'object')],
    parameters: [
      { name: 'prompt', displayName: 'Prompt', type: 'string', required: true, typeOptions: { rows: 6 },
        placeholder: 'Work with the data — e.g. “From {{input}}, return the symbol with the biggest 24h gain.”' },
      { name: 'model', displayName: 'Model', type: 'options', default: 'gemini-2.5-flash',
        options: [{ name: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' }, { name: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' }] },
      { name: 'search', displayName: 'Web search grounding', type: 'boolean', default: false },
      { name: 'schema', displayName: 'Output schema (JSON)', type: 'json', typeOptions: { editor: 'json' },
        description: 'Declares the output fields → becomes this node’s output ports.' },
      ...ERROR_POLICY_PARAMS,
    ],
  },
  code: {
    type: 'code', label: 'Code', group: 'Transform', icon: 'code',
    description: 'A code module: receives ctx, returns an object of output fields. AI can write it; you can edit it. ctx.input is the upstream data (already parsed); with several inputs connected it waits for all and ctx.input is keyed by each source node\u2019s label. ctx.inputs.<port> is the raw items array.',
    inputs: [port('in', 'In', 'any')], outputs: [port('out', 'Out', 'any')],
    parameters: [
      { name: 'code', displayName: 'Code', type: 'code', typeOptions: { editor: 'code' },
        default:
          '// ctx.input  = upstream data, parsed & unwrapped. Several inputs? All have finished, keyed\n' +
          '//              by source node label: ctx.input["HTTP request"], ctx.input["HTTP request 2"]\n' +
          '// ctx.inputs = { <port>: items[] }   ctx.config = this node\'s config\n' +
          'export default function run(ctx) {\n' +
          '  const data = ctx.input;\n' +
          '  return { result: data };\n' +
          '}\n' },
      ...ERROR_POLICY_PARAMS,
    ],
  },
  if: {
    type: 'if', label: 'If', group: 'Logic', icon: 'branch',
    description: 'Branches the flow on a condition.',
    inputs: [port('in', 'In', 'any')], outputs: [port('true', 'True', 'any'), port('false', 'False', 'any')],
    parameters: [
      { name: 'condition', displayName: 'Condition', type: 'string', required: true, placeholder: '{{ $json.value > 0 }}' },
    ],
  },
  template: {
    type: 'template', label: 'Apply template', group: 'Render', icon: 'template',
    description: 'Binds incoming values into a FeedForce template’s identifiers and writes slides.',
    inputs: [port('data', 'Data', 'object')], outputs: [port('out', 'Slide', 'object')],
    parameters: [
      { name: 'templateId', displayName: 'Template', type: 'options', required: true,
        typeOptions: { loadOptionsMethod: 'templates' },
        description: 'Pick one of your FeedForce templates by name (its identifiers become bindable inputs).' },
    ],
  },
  // Render data into a saved AI element (chart/table/candlestick/…). Its INPUT ports are set per-instance
  // from the chosen element's inputSchema (see AutomationsSection → setConfig), so upstream nodes map data
  // straight into the element. A sink for now (run-time rendering lands in a later phase).
  element: {
    type: 'element', label: 'Element', group: 'Render', icon: 'template',
    description: 'Render data into one of your saved AI elements — pick it, then map upstream fields to its inputs.',
    inputs: [], outputs: [],
    parameters: [
      { name: 'elementId', displayName: 'Element', type: 'options', required: true,
        typeOptions: { loadOptionsMethod: 'elements' },
        description: 'Pick a saved data element; its inputs become this node’s ports.' },
    ],
  },
  post: {
    type: 'post', label: 'Post', group: 'Output', icon: 'send',
    description: 'Publishes the slides from the connected “Apply template” node to an Instagram account — pick the account, caption and timing in the panel.',
    inputs: [port('in', 'In', 'any')], outputs: [],
    parameters: [],
  },
};

export const DESCRIPTOR_LIST = Object.values(NODE_DESCRIPTORS);

/** Build a fresh FlowNode-shaped object from a descriptor (ports copied, config defaulted). */
export function instantiate(type: string, id: string, x: number, y: number) {
  const d = NODE_DESCRIPTORS[type];
  if (!d) throw new Error(`Unknown node type: ${type}`);
  return {
    id, type, x, y,
    config: defaultConfig(d.parameters),
    inputs: d.inputs.map(p => ({ ...p })),
    outputs: d.outputs.map(p => ({ ...p })),
  };
}
