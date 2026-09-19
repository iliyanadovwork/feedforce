// Shared safety gate for AI-generated custom-element code (the (ctx, props) draw-function body that
// runs in the browser via new Function — see runtime.ts). Two failure modes to block:
//   1. escaping the canvas sandbox (globals, network, storage, dynamic code)
//   2. freezing the tab with a loop that never terminates
// A regex can't prove termination, but it catches every obvious spelling; the else-branch loops
// (`for(...;;...)`, `while(true|1|!0)`, `do{}while(1)`) had bypasses in the old per-route regexes.

// `constructor` is banned because `(()=>{}).constructor` IS the Function constructor — the classic
// regex-sandbox escape that reaches `Function`/the global object without ever writing "Function".
// A regex is a tripwire, NOT a real sandbox: an attacker who builds an identifier from string pieces
// (`['fet'+'ch']`) still slips through, so this is defense-in-depth, not a guarantee.
const ESCAPE_APIS = /\b(window|document|fetch|XMLHttpRequest|import|require|eval|Function|constructor|globalThis|localStorage|sessionStorage|indexedDB|WebSocket|Worker)\b/;
// window's aliases resolve to the same global object (self===window on the main thread; top/parent/
// frames/location navigate/reach globals). Ban them ONLY as a member root (`.`/`[`) so legit canvas
// values and coordinates — ctx.textBaseline='top', `const top = 10`, `rect, `left` — aren't over-blocked.
const GLOBAL_ALIASES = /\b(self|top|parent|frames|location)\s*(?:\.|\[)/;
const ENDLESS_LOOP = /while\s*\(\s*(?:true|!*\d+)\s*\)|for\s*\([^)]*;\s*;/;

/** True when the element code passes the sandbox + termination heuristics. */
export function isElementCodeSafe(code: string): boolean {
  return !ESCAPE_APIS.test(code) && !GLOBAL_ALIASES.test(code) && !ENDLESS_LOOP.test(code);
}
