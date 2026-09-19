// Automations engine — public surface (Phase 0).
export type {
  DataType, Port, FlowNode, Edge, Graph, Item, PortData,
  RunInputs, RunOutputs, RunContext, RunServices, NodeTypeDef, NodeRegistry,
} from './types';
export { toItems } from './types';
export { canConnect, coerce } from './binding';
export { topoSort, resolveInputs } from './graph';
export { runGraph, runGraphUpTo, NodeRunError, graphLimitError, MAX_NODES, MAX_AI_NODES, type RunResult } from './engine';
export type { ParamType, ParamOption, DisplayOptions, ParamTypeOptions, NodeParam } from './params';
export { isParamVisible, defaultConfig, missingRequired } from './params';
export type { NodeDescriptor, NodeGroup } from './descriptors';
export { NODE_DESCRIPTORS, DESCRIPTOR_LIST, instantiate } from './descriptors';
export type { FlatKey } from './mapping';
export { flattenKeys, lastSegment, extractPlaceholders, autoMatch, collectStrings, getAtPath, fillText } from './mapping';
