// Node parameter system (the config-panel "brain"), modeled on n8n's INodeProperties. Pure + tested.
// The editor renders a node's NodeParam[] into a form; displayOptions drive conditional visibility.

export type ParamType =
  | 'string' | 'number' | 'boolean' | 'json'
  | 'options' | 'multiOptions'
  | 'collection' | 'fixedCollection'
  | 'credential' | 'code'
  | 'dateTime' | 'color' | 'resourceLocator' | 'filter'
  | 'notice' | 'hidden';

export interface ParamOption {
  name: string;
  value: string | number | boolean;
  description?: string;
}

/** Conditional visibility — a field shows when ALL `show` keys match and no `hide` group fully matches. */
export interface DisplayOptions {
  show?: Record<string, Array<string | number | boolean>>;
  hide?: Record<string, Array<string | number | boolean>>;
}

export interface ParamTypeOptions {
  password?: boolean;
  rows?: number;
  multipleValues?: boolean;
  editor?: 'code' | 'json';
  /** Name of a dynamic-options source (e.g. 'templates') resolved at render time. */
  loadOptionsMethod?: string;
}

export interface NodeParam {
  name: string;
  displayName: string;
  type: ParamType;
  default?: unknown;
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: ParamOption[];
  typeOptions?: ParamTypeOptions;
  displayOptions?: DisplayOptions;
  noDataExpression?: boolean;
}

/** Does every key in `cond` have a current value listed in its allowed array? */
function allMatch(cond: Record<string, Array<string | number | boolean>>, values: Record<string, unknown>): boolean {
  return Object.entries(cond).every(([key, allowed]) => allowed.includes(values[key] as string | number | boolean));
}

/** Evaluate a param's displayOptions against the current config values (n8n semantics). */
export function isParamVisible(param: NodeParam, values: Record<string, unknown>): boolean {
  const d = param.displayOptions;
  if (!d) return true;
  if (d.show && !allMatch(d.show, values)) return false;
  if (d.hide && allMatch(d.hide, values)) return false;
  return true;
}

/** Build the initial config object from a param list (skips `notice`; uses each param's default). */
export function defaultConfig(params: NodeParam[]): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const p of params) {
    if (p.type === 'notice' || p.type === 'hidden') continue;
    if (p.default !== undefined) cfg[p.name] = p.default;
  }
  return cfg;
}

/** Required, visible params that are still empty — for surfacing "needs setup" on a node. */
export function missingRequired(params: NodeParam[], values: Record<string, unknown>): string[] {
  return params
    .filter(p => p.required && isParamVisible(p, values))
    .filter(p => {
      const v = values[p.name];
      return v === undefined || v === null || v === '';
    })
    .map(p => p.name);
}
