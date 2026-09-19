'use client';

import { useRef, type ReactNode, type UIEvent, type KeyboardEvent } from 'react';

// Dependency-free syntax-highlighted code editor (the automations Code node). The classic overlay
// technique: a <pre> renders the tokenised code underneath a same-metrics textarea whose TEXT is
// transparent — the caret and selection stay native, the colours come from the layer below, and
// scrolling is mirrored on every scroll event. No Monaco/CodeMirror: the snippets here are ~30-line
// transforms, and a hand-rolled JS tokenizer keeps the editor at zero bundle cost.

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw',
  'class', 'extends', 'super', 'this', 'async', 'await', 'yield', 'delete', 'void', 'export', 'default', 'import', 'from',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const BUILTINS = new Set(['JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'console', 'ctx']);

// One pass, longest-first alternation: comments | strings/templates | numbers | words. Anything
// between matches renders as plain text. Unterminated strings highlight to end-of-line, which is the
// familiar IDE behaviour while typing.
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

/** Classify a bare identifier from its neighbours, One-Dark style: `name(` = function call (blue),
 *  `.name` / `name:` = property or object key (red), known globals = builtin (cyan). */
function wordClass(word: string, src: string, start: number, end: number): string | null {
  if (KEYWORDS.has(word)) return 'de-tok-k';
  if (LITERALS.has(word)) return 'de-tok-l';
  let j = end;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  if (src[j] === '(') return 'de-tok-f';                       // function call / declaration name
  if (src[start - 1] === '.') return 'de-tok-p';               // property access
  if (src[j] === ':' && src[j + 1] !== ':') return 'de-tok-p'; // object-literal key
  if (BUILTINS.has(word)) return 'de-tok-l';
  return null;
}

function tokenize(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(src.slice(last, i));
    const [text, comment, str, num, word] = m;
    const cls = comment ? 'de-tok-c' : str ? 'de-tok-s' : num ? 'de-tok-n'
      : word ? wordClass(word, src, i, i + text.length)
      : null;
    out.push(cls ? <span key={key++} className={cls}>{text}</span> : text);
    last = i + text.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export function CodeEditor({ value, onChange, rows = 10, placeholder, ariaLabel }: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);

  const syncScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollTop = e.currentTarget.scrollTop;
    pre.scrollLeft = e.currentTarget.scrollLeft;
  };

  // Tab indents (two spaces) instead of leaving the field — table stakes for a code box.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en } = el;
    onChange(value.slice(0, s) + '  ' + value.slice(en));
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
  };

  // Both layers MUST share font, padding, line-height and wrapping so glyphs align 1:1. The trailing
  // newline keeps the <pre> as tall as the textarea when the code ends in an empty line.
  const layer = 'm-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] p-3';

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-page focus-within:border-fg-4">
      <pre ref={preRef} aria-hidden className={`${layer} pointer-events-none absolute inset-0 overflow-hidden text-fg-2`}>
        {tokenize(value)}{'\n'}
      </pre>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel ?? 'Code'}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={`${layer} relative block w-full resize-y bg-transparent text-transparent caret-fg outline-none placeholder:text-fg-4`}
      />
    </div>
  );
}
