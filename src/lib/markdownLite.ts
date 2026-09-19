// A deliberately tiny, safe Markdown subset for the copilot reply bubbles — enough for the prose the
// model actually writes (bold, italic, `code`, links, bullet/numbered lists, line breaks) and nothing
// that needs raw HTML. The tokenizers here are pure so they can be unit-tested; MarkdownLite.tsx maps
// the tokens to React elements (never dangerouslySetInnerHTML), so AI output can't inject markup.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string };

// Only these schemes become real links; anything else renders as plain text (no javascript:, data:, etc.).
function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

// Ordered by precedence; the earliest match in the string wins each step. Emphasis markers must hug
// non-space characters (standard Markdown) so arithmetic like "2 * 3 * 4" isn't read as italic.
const CODE = /`([^`]+)`/;
// `_`/`__` emphasis needs word boundaries so intraword underscores (my_var_name) aren't emphasis
// (CommonMark). `*`/`**` may be intraword, so they keep the plain non-space-hug rule.
const BOLD = /\*\*(\S(?:[^*]*\S)?)\*\*|(?<!\w)__(\S(?:[^_]*\S)?)__(?!\w)/;
const ITALIC = /\*(\S(?:[^*\n]*\S)?)\*|(?<!\w)_(\S(?:[^_\n]*\S)?)_(?!\w)/;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;

export function parseInline(input: string): Inline[] {
  const out: Inline[] = [];
  let rest = input;

  while (rest.length > 0) {
    // Find the earliest-occurring markup among the patterns.
    let best: { idx: number; len: number; token: Inline } | null = null;
    const consider = (m: RegExpMatchArray | null, make: (m: RegExpMatchArray) => Inline) => {
      if (!m || m.index == null) return;
      if (best === null || m.index < best.idx) best = { idx: m.index, len: m[0].length, token: make(m) };
    };
    consider(rest.match(CODE), m => ({ t: 'code', v: m[1] }));
    consider(rest.match(BOLD), m => ({ t: 'bold', v: m[1] ?? m[2] }));
    consider(rest.match(ITALIC), m => ({ t: 'italic', v: m[1] ?? m[2] }));
    consider(rest.match(LINK), m => {
      const href = safeHref(m[2]);
      return href ? { t: 'link', v: m[1], href } : { t: 'text', v: m[0] };
    });

    if (best === null) { out.push({ t: 'text', v: rest }); break; }
    const b: { idx: number; len: number; token: Inline } = best;
    if (b.idx > 0) out.push({ t: 'text', v: rest.slice(0, b.idx) });
    out.push(b.token);
    rest = rest.slice(b.idx + b.len);
  }

  // Merge adjacent text tokens (keeps the output minimal / stable).
  return out.reduce<Inline[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (tok.t === 'text' && prev && prev.t === 'text') prev.v += tok.v;
    else acc.push(tok);
    return acc;
  }, []);
}

export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] };

const UL_ITEM = /^\s*[-*•]\s+(.*)$/;
const OL_ITEM = /^\s*\d+\.\s+(.*)$/;

// Group lines into paragraphs and lists. A blank line separates paragraphs; runs of list-item lines
// (same kind) become one list; other non-blank lines join into a paragraph with <br> between them.
export function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: Inline[][] | null = null;
  const flushPara = () => { if (para && para.length) blocks.push({ t: 'p', lines: para }); para = null; };

  for (const line of lines) {
    if (line.trim() === '') { flushPara(); continue; }
    const ul = line.match(UL_ITEM);
    const ol = ul ? null : line.match(OL_ITEM);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      const item = parseInline((ul ?? ol!)[1]);
      const last = blocks[blocks.length - 1];
      if (last && last.t === kind) last.items.push(item);
      else blocks.push(kind === 'ul' ? { t: 'ul', items: [item] } : { t: 'ol', items: [item] });
    } else {
      (para ??= []).push(parseInline(line));
    }
  }
  flushPara();
  return blocks;
}
