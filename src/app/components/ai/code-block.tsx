'use client';

// Dependency-free code display for the copilot: a tiny regex tokenizer colours JS/TS with the app's own scale
// tokens (no highlighter library — same philosophy as MarkdownLite), a `CodeBlock` for fresh code and a
// `CodeDiff` for refinements (LCS line diff, red/green). Both show a compact inline view and expand into a
// scrollable pop-out modal that is styled as a larger version of the same inline card. The tokenizer isn't a
// full grammar (regex literals / template interpolation / JSX may mis-colour) but it's ~90% right for the
// generated canvas draw-code we show. Swap `highlight()` for a real library later if you ever need perfection.
import { cn } from '@/lib/utils';
import { Maximize2Icon, XIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'of', 'in', 'new',
  'class', 'extends', 'import', 'export', 'from', 'default', 'await', 'async', 'try', 'catch', 'finally',
  'throw', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof', 'void', 'delete', 'yield',
  'this', 'super', 'null', 'undefined', 'true', 'false',
]);

// One master regex: (1) comments, (2) strings, (3) numbers, (4) identifiers. Everything else falls through
// as plain text. Every alternative matches ≥1 char, so exec() can't loop on a zero-width match.
const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(code); m; m = TOKEN_RE.exec(code)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [full, comment, str, num, ident] = m;
    let cls: string | null = null;
    if (comment) cls = 'text-[var(--zinc-500)] italic';
    else if (str) cls = 'text-[var(--green-400)]';
    else if (num) cls = 'text-[var(--amber-400)]';
    else if (ident && KEYWORDS.has(ident)) cls = 'text-[var(--blue-400)]';
    out.push(cls ? <span key={key++} className={cls}>{full}</span> : full);
    last = m.index + full.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

// Shared header icon-button (expand / close) so both places look identical.
const HEADER_BTN = 'focus-ring ml-auto grid size-5 shrink-0 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg';

// The highlighted <pre> body — shared between the inline view and the modal (both use the base p-3).
function CodePre({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={cn('p-3 font-mono text-[12px] leading-relaxed text-fg-2', className)}>
      <code>{highlight(code)}</code>
    </pre>
  );
}

// Header row — identical in the inline card and the pop-out modal; only the trailing button differs.
function CodeHeader({ title, extra, trailing }: { title?: string; extra?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-fg-3">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m8 8-4 4 4 4M16 8l4 4-4 4" /></svg>
      {title && <span className="truncate font-mono">{title}</span>}
      {extra}
      {trailing}
    </div>
  );
}

// The pop-out: the SAME card as inline (rounded-md, border-line, bg-surface-3, p-3, shared header) — just
// larger, elevated with a shadow, over a blurred backdrop. Portaled to <body> so it escapes the panel's
// overflow-hidden; Esc / backdrop / × close it.
function CodeModal({ title, extra, onClose, children }: { title: string; extra?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm sm:p-8" onMouseDown={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-line bg-surface-3 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.8)]" onMouseDown={e => e.stopPropagation()}>
        <CodeHeader title={title} extra={extra} trailing={<button onClick={onClose} aria-label="Close" title="Close" className={HEADER_BTN}><XIcon className="size-3.5" /></button>} />
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export type CodeBlockProps = {
  code: string;
  /** Header label — e.g. the element name. */
  title?: string;
  className?: string;
};

export function CodeBlock({ code, title, className }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const clean = code.replace(/\n+$/, '');

  return (
    <div className={cn('overflow-hidden rounded-md border border-line bg-surface-3', className)}>
      <CodeHeader title={title ?? 'code'} trailing={<button onClick={() => setExpanded(true)} aria-label="Expand" title="Expand" className={HEADER_BTN}><Maximize2Icon className="size-3.5" /></button>} />
      {/* full code in a fixed-height box that scrolls BOTH ways on hover; the ⤢ header button pops it out */}
      <CodePre code={clean} className="max-h-64 overflow-auto" />
      {expanded && (
        <CodeModal title={title ?? 'code'} onClose={() => setExpanded(false)}>
          <CodePre code={clean} />
        </CodeModal>
      )}
    </div>
  );
}

// ── Diff ────────────────────────────────────────────────────────────────────────────────────────────
type DiffRow = { type: 'same' | 'add' | 'del' | 'gap'; text: string };

/** Classic LCS line diff: the shortest set of add/del ops that turns oldStr into newStr. */
function lineDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Keep only changed lines + `context` lines around them; collapse long unchanged runs to a "⋯" marker. */
function collapseContext(rows: DiffRow[], context: number): DiffRow[] {
  const show = rows.map(r => r.type !== 'same');
  rows.forEach((r, i) => {
    if (r.type !== 'same') {
      for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) show[k] = true;
    }
  });
  const out: DiffRow[] = [];
  let hidden = 0;
  const flush = () => { if (hidden) { out.push({ type: 'gap', text: `⋯ ${hidden} unchanged line${hidden > 1 ? 's' : ''}` }); hidden = 0; } };
  rows.forEach((r, i) => { if (show[i]) { flush(); out.push(r); } else hidden++; });
  flush();
  return out;
}

// The diff <pre> body — shared between the inline (context-collapsed) view and the modal (full).
function DiffPre({ rows, className }: { rows: DiffRow[]; className?: string }) {
  return (
    <pre className={cn('py-1 font-mono text-[12px] leading-relaxed text-fg-2', className)}>
      {rows.map((r, i) =>
        r.type === 'gap' ? (
          <div key={i} className="select-none px-3 py-0.5 text-[11px] text-fg-4">{r.text}</div>
        ) : (
          <div
            key={i}
            className={cn(
              'flex px-3',
              r.type === 'add' && 'bg-[color-mix(in_oklab,var(--green-500)_16%,transparent)]',
              r.type === 'del' && 'bg-[color-mix(in_oklab,var(--red-500)_16%,transparent)]',
            )}
          >
            <span className={cn('mr-2 w-2 shrink-0 select-none', r.type === 'add' ? 'text-[var(--green-400)]' : r.type === 'del' ? 'text-[var(--red-400)]' : 'text-transparent')}>
              {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ''}
            </span>
            <span className={cn('min-w-0', r.type === 'del' && 'opacity-80')}>{highlight(r.text)}</span>
          </div>
        ),
      )}
    </pre>
  );
}

export type CodeDiffProps = {
  oldCode: string;
  newCode: string;
  title?: string;
  /** Unchanged lines kept around each change in the inline view. Default 3. */
  context?: number;
  className?: string;
};

export function CodeDiff({ oldCode, newCode, title, context = 3, className }: CodeDiffProps) {
  const [expanded, setExpanded] = useState(false);
  const raw = lineDiff(oldCode.replace(/\n+$/, ''), newCode.replace(/\n+$/, ''));
  const added = raw.filter(r => r.type === 'add').length;
  const removed = raw.filter(r => r.type === 'del').length;
  const inline = collapseContext(raw, context);
  const counts = (
    <span className="flex items-center gap-1.5 tabular-nums">
      <span className="text-[var(--green-400)]">+{added}</span>
      <span className="text-[var(--red-400)]">-{removed}</span>
    </span>
  );

  return (
    <div className={cn('overflow-hidden rounded-md border border-line bg-surface-3', className)}>
      <CodeHeader title={title ?? 'diff'} extra={counts} trailing={<button onClick={() => setExpanded(true)} aria-label="Expand" title="Expand" className={HEADER_BTN}><Maximize2Icon className="size-3.5" /></button>} />
      <DiffPre rows={inline} className="max-h-64 overflow-auto" />
      {expanded && (
        <CodeModal title={title ?? 'diff'} extra={counts} onClose={() => setExpanded(false)}>
          <DiffPre rows={raw} />
        </CodeModal>
      )}
    </div>
  );
}
