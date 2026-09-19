// Incremental extractor for the `reply` prose field of the copilot's JSON response.
//
// The editor/reel copilots answer in JSON mode as { "reply": "<prose>", "actions": [...] } (carousel)
// or { "reply": "<prose>", "patch": {...} } (reels) — and the system prompts put `reply` FIRST, so in a
// streamed response its characters arrive before the structured edits. This lets us forward the prose to
// the browser token-by-token while the structured `actions`/`patch` are still parsed WHOLE (and zod-
// validated) at end-of-stream, keeping edits atomic.
//
// This never parses the structured part. It walks a growing JSON document, finds the `reply` value, and
// emits its decoded characters as they become available — honoring JSON string escapes and never emitting
// a half-received escape sequence (so a chunk boundary that splits `é` or `\"` is safe).

const ESCAPES: Record<string, string> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

export interface ReplyExtractor {
  /** Feed the next raw text chunk; returns any newly-decoded reply characters (possibly ''). */
  push(chunk: string): string;
  /** True once the reply string has been fully read (its closing quote seen). */
  done(): boolean;
}

export function createReplyExtractor(): ReplyExtractor {
  let buf = '';
  let scan = 0;                                  // index in buf up to which we've consumed
  let phase: 'seek' | 'string' | 'done' = 'seek';

  function push(chunk: string): string {
    if (phase === 'done') return '';             // reply fully read — ignore the trailing structured JSON
    buf += chunk;
    let out = '';

    if (phase === 'seek') {
      // Locate the reply value's opening quote: the first " after the "reply" key and its colon.
      // The exact `"reply"` (with both quotes) can't match a longer key like `"replies"`.
      const k = buf.indexOf('"reply"');
      if (k === -1) return '';
      const colon = buf.indexOf(':', k + 7);
      if (colon === -1) return '';
      const q = buf.indexOf('"', colon + 1);
      if (q === -1) return '';
      scan = q + 1;
      phase = 'string';
    }

    // phase === 'string'
    while (scan < buf.length) {
      const c = buf[scan];
      if (c === '\\') {
        if (scan + 1 >= buf.length) break;        // escape payload not here yet — wait for more
        const e = buf[scan + 1];
        if (e === 'u') {
          if (scan + 6 > buf.length) break;       // need all of \uXXXX
          const code = parseInt(buf.slice(scan + 2, scan + 6), 16);
          out += Number.isNaN(code) ? '' : String.fromCharCode(code);
          scan += 6;
        } else {
          out += ESCAPES[e] ?? e;                 // unknown escape → emit the raw char (lenient)
          scan += 2;
        }
      } else if (c === '"') {
        scan += 1;
        phase = 'done';
        break;
      } else {
        out += c;
        scan += 1;
      }
    }
    return out;
  }

  return { push, done: () => phase === 'done' };
}
