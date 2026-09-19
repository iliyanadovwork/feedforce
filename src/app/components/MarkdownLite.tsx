import { Fragment, type ReactNode } from 'react';
import { parseBlocks, parseInline, type Inline } from '@/lib/markdownLite';

// Renders the tiny Markdown subset (see lib/markdownLite.ts) as React elements — never raw HTML, so
// AI-authored reply text can't inject markup. Used for the copilot's committed reply bubbles.

function renderInline(tokens: Inline[], prefix = ''): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${prefix}${i}`;
    switch (tok.t) {
      case 'bold': return <strong key={key} className="font-semibold text-fg">{tok.v}</strong>;
      case 'italic': return <em key={key}>{tok.v}</em>;
      case 'code': return <code key={key} className="rounded bg-surface-3 px-1 py-0.5 text-[0.85em] font-mono">{tok.v}</code>;
      case 'link': return <a key={key} href={tok.href} target="_blank" rel="noopener noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-fg">{tok.v}</a>;
      default: return <Fragment key={key}>{tok.v}</Fragment>;
    }
  });
}

// Join a paragraph's lines with <br> (single newlines are soft breaks within a paragraph). Inline keys
// are namespaced per line so tokens flattened into one <p> stay unique.
function renderLines(lines: Inline[][]): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`br${i}`} />);
    out.push(...renderInline(line, `l${i}-`));
  });
  return out;
}

export function MarkdownLite({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {blocks.map((block, i) => {
        if (block.t === 'ul') {
          return <ul key={i} className="ml-4 list-disc space-y-0.5">{block.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
        }
        if (block.t === 'ol') {
          return <ol key={i} className="ml-4 list-decimal space-y-0.5">{block.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>;
        }
        return <p key={i}>{renderLines(block.lines)}</p>;
      })}
    </div>
  );
}

// Convenience for a single inline string (no block structure) — reserved for future one-liners.
export function InlineMarkdown({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>;
}
