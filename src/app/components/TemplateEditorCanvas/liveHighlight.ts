// Live {placeholder} highlighting inside the canvas's contentEditable text editors. Wraps tokens in a
// `.de-ph` span (gray via CSS) so they read like variables WHILE you type — matching the on-canvas
// render. Visual only: the class carries no inline color, so htmlToSpans (which reads inline `style.color`)
// ignores it and nothing is persisted into the saved spans. Caret is preserved by character offset, and
// existing styled element spans are kept (we only re-tokenise text nodes).

const TOKEN_RE = /\{[a-zA-Z0-9_.-]+\}/g;

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return -1;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(sel.anchorNode as Node, sel.anchorOffset);
  return r.toString().length;
}

function restoreCaret(el: HTMLElement, offset: number): void {
  if (offset < 0) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = (node.nodeValue ?? '').length;
    if (remaining <= len) {
      const r = document.createRange();
      r.setStart(node, remaining);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      return;
    }
    remaining -= len;
  }
}

export function highlightPlaceholders(el: HTMLElement): void {
  const offset = caretOffset(el);

  // Unwrap previous token spans back to plain text, then re-merge adjacent text nodes.
  el.querySelectorAll('span.de-ph').forEach(s => s.replaceWith(document.createTextNode(s.textContent ?? '')));
  el.normalize();

  // Re-tokenise: wrap {tokens} found in text nodes (leaves styled element spans untouched).
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) texts.push(n as Text);

  for (const tn of texts) {
    const text = tn.nodeValue ?? '';
    if (text.indexOf('{') === -1) continue;
    TOKEN_RE.lastIndex = 0;
    if (!TOKEN_RE.test(text)) continue;
    TOKEN_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'de-ph';
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.replaceWith(frag);
  }

  restoreCaret(el, offset);
}
