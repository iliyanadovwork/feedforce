// Automations engine — core types (Phase 0). Pure, framework-free, fully unit-tested.
// See production/AUTOMATIONS_DESIGN.md. v1 execution is synchronous + fail-fast; data is item-based
// (n8n model) so arrays fan out into per-item processing (e.g. an AI's slide[] → N carousel slides).

/** Port value types — used for type-aware binding & coercion (binding.ts). */
export type DataType =
  | 'string' | 'number' | 'boolean'
  | 'image' | 'video' | 'series'
  | 'array' | 'object' | 'any';

/** A named, typed connection point on a node. */
export interface Port {
  id: string;
  name: string;
  dataType: DataType;
  jsonPath?: string;   // for source ports: where in the response this value lives
}

/** A node placed in a flow. `config` holds node-type-specific params (panel values). */
export interface FlowNode {
  id: string;
  type: string;                 // NodeTypeId — key into the registry
  x?: number; y?: number;
  label?: string;
  config?: Record<string, unknown>;
  inputs: Port[];
  outputs: Port[];
}

/** A port→port connection (field-level binding). */
export interface Edge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface Graph {
  nodes: FlowNode[];
  edges: Edge[];
}

/** One unit of data flowing along a connection (n8n's INodeExecutionData). */
export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  /** index of the input item that produced this one — for run-log tracing. */
  pairedItem?: number;
  /** Display label of the node this item came from (stamped by resolveInputs). Lets fan-in consumers
      (code/AI/template) expose multiple upstreams as one object keyed by source label — the same
      shape the binding UI shows (AutomationsSection.incomingData). */
  source?: string;
}

/** The data carried on a single port = an array of items. */
export type PortData = Item[];

/** Inputs/outputs of a node run, keyed by port name. */
export type RunInputs = Record<string, PortData>;
export type RunOutputs = Record<string, PortData>;

/** Server-only capabilities a node may use at run time. Optional so the pure engine + its unit tests
 * never need them; the API routes inject real implementations (Gemini, service-role DB). */
export interface RunServices {
  /** Constrained-JSON LLM call. Returns the raw model text (caller parses). */
  llm?(prompt: string, opts?: { system?: string; json?: boolean; model?: string; temperature?: number }): Promise<string>;
  /** Service-role Supabase client for nodes that persist (Template → posts). Typed loosely to keep the
   *  engine framework-free; serverNodes narrows it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  /** Look up a stored credential's secret by id (decrypted server-side; never reaches the browser). */
  getCredentialSecret?(id: string): Promise<string | null>;
}

/** Context passed to a node's run(). config + inputs are always present; userId/services are injected
 *  server-side (absent in pure-engine tests). */
export interface RunContext {
  config: Record<string, unknown>;
  inputs: RunInputs;
  userId?: string;
  services?: RunServices;
}

/** The executable contract for a node type. (The panel/manifest layer comes in later phases.) */
export interface NodeTypeDef {
  id: string;
  run(ctx: RunContext): RunOutputs | Promise<RunOutputs>;
}

export type NodeRegistry = Record<string, NodeTypeDef>;

/** Convenience: wrap plain objects as items (sets pairedItem to the source index). */
export function toItems(records: Record<string, unknown>[]): Item[] {
  return records.map((json, i) => ({ json, pairedItem: i }));
}
