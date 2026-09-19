// Text helpers + prompts for the Content Sheet's AI caption/description generator (ported from the
// original reels pipeline, behavior-preserving). Two AI products:
//   • the on-template CAPTION — the creator overlay read VERBATIM off video frames by a vision model
//   • the DESCRIPTION (Instagram post caption) — written fresh from a topic with search grounding
// Everything in this file is pure (no fetch, no env) so it's unit-testable and client-safe.

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

// Decode named + decimal (&#NN;) + hex (&#xNN;) entities, including astral code points (emoji).
// Unknown/invalid entities are left as-is.
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try { return String.fromCodePoint(cp); } catch { return m; }
      }
      return m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : m;
  });
}

// Emoji / pictograph / dingbat / flag ranges. Deliberately EXCLUDES general punctuation
// (U+2000–206F), currency, math, CJK, and plain arrows (→ U+2192) so real text is preserved;
// only emoji-style symbols are removed.
const EMOJI_RE =
  /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{2049}\u{203C}\u{2122}\u{2139}\u{2194}-\u{21AA}\u{231A}\u{231B}\u{23E9}-\u{23FA}\u{24C2}\u{25AA}-\u{25FE}\u{2934}\u{2935}\u{3030}\u{303D}\u{3297}\u{3299}]\u{FE0F}?\u{20E3}?|[\u{FE00}-\u{FE0F}\u{200D}])/gu;

// Promo / CTA phrases to strip from scraped source descriptions. Restricted to multi-word or
// colon-anchored phrasings that essentially never appear in descriptive prose, so "flew via London"
// or "give the rookie credit" survive. Optional lead-ins ("don't forget to …") are consumed so the
// whole CTA goes, not a dangling fragment. All quantifiers bounded — no ReDoS exposure.
const LEADIN =
  "(?:(?:please|pls|go|now|don'?t\\s+forget\\s+to|don'?t\\s+forget|make\\s+sure\\s+(?:to|you)|be\\s+sure\\s+to|remember\\s+to|hit\\s+that|smash\\s+that)\\s+){0,2}";
const PROMO_BODY = [
  "follow(?:\\s+(?:us|for|more|me))+",
  "follow\\s+@\\S+",
  "link\\s+in\\s+(?:my\\s+)?bio",
  "turn\\s+on\\s+[\\w\\s]{0,20}notif\\w*",
  "post\\s+notif\\w*",
  "dm\\s+(?:us|me)\\b",
  "double\\s+tap",
  "swipe\\s+(?:up|left|right)",
  "tag\\s+(?:a\\s+friend|someone)",
  "comment\\s+(?:below|down)",
  "(?:save|share)\\s+(?:this|the)\\s+(?:post|reel|video|clip)",
  "via\\s*:",       // colon-anchored: "Via: X" is attribution, "flew via London" is not
  "credits?\\s*:",  // colon-anchored: "Credits:" is attribution, "credit to crew" is not
].join("|");
const PROMO_RE = new RegExp(LEADIN + "(?:" + PROMO_BODY + ")", "gi");

/** Turns a raw scraped source description into a clean, single-line AI topic: decodes entities,
 *  strips emoji / hashtags / @handles / promo CTAs, and drops a line only if nothing substantive
 *  remains — never destroys real prose. */
export function cleanDescription(input: string | null | undefined): string {
  if (!input) return '';
  const decoded = decodeHtmlEntities(String(input)).replace(/\r\n?/g, '\n');

  const kept: string[] = [];
  for (const rawLine of decoded.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^[\s\-–—_=*·•.]+$/.test(line)) continue; // pure separator

    line = line
      .replace(EMOJI_RE, '')
      .replace(/(^|\s)#[^\s#]+/g, '$1')          // hashtags (never prose)
      .replace(/(^|\s)@[A-Za-z0-9._]+/g, '$1')   // @handles (leaves the sentence)
      .replace(PROMO_RE, ' ')
      .replace(/\s+([,;:.!?])/g, '$1')
      .replace(/([,;:.!?])(?:\s*[,;:.!?])+/g, '$1') // collapse orphaned runs (", ," → ",")
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;:.!?\-–—]+|[\s,;:\-–—]+$/g, '')
      .trim();

    if (line.replace(/[^A-Za-z0-9]/g, '').length < 3) continue;
    kept.push(line);
  }

  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/** Removes source-citation markers a grounded model may leak into a generated caption — bracketed
 *  domain groups ("[wikipedia.org]"), numbered refs ("[1]", "[1, 2]"), and markdown footnotes
 *  ("[^2]") — while leaving ordinary prose and years like [2005] untouched. */
export function stripSourceCitations(input: string | null | undefined): string {
  if (!input) return '';
  return String(input)
    .replace(/\s*\[[^\]\n]*?\b[a-z0-9-]+\.[a-z]{2,}[^\]\n]*?\]/gi, '')
    .replace(/\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '')
    .replace(/\s*\[\^\d+\]/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim();
}

/** Trims a caption to `max` without cutting mid-sentence/word: prefers the last sentence end, then
 *  the last space, before falling back to a hard slice. */
export function capCaption(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('\n')
  );
  if (lastSentence > max * 0.6) return slice.slice(0, lastSentence + 1).trim();
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}

// The model undershoots length targets, so the prompt aims ~2200-2400 and the result is hard-cropped
// to DESCRIPTION_MAX at a sentence boundary — captions reliably land in the wanted ~1500-2000 range
// (Instagram's own cap is 2200).
export const DESCRIPTION_MAX = 2000;

// Fixed prompt prefix for the description — the topic is appended after "Topic:".
export const DESCRIPTION_PROMPT_PREFIX =
  'Generate me an instagram caption, no emojis, in exactly 2 paragraphs, on this topic. ' +
  'Before writing, you must use Google Search to look up current, accurate, up-to-date ' +
  'information about the topic, and base the caption on what you find — do not rely on prior knowledge alone. ' +
  'The topic below may be a raw social-media caption containing hashtags, emojis, @handles, ' +
  'and promotional calls-to-action (e.g. "follow us", "link in bio", "via ..."). Ignore all of ' +
  'that noise entirely — write only about the substantive subject, and never reproduce hashtags, ' +
  '@handles, or promo text in your caption. ' +
  'Do NOT include any source citations, URLs, website names, domain names, or reference markers ' +
  '(e.g. "[wikipedia.org]" or "[1]") in the caption — write it as clean prose with no references. ' +
  'Write a rich, detailed, thorough caption — aim for roughly 2200 to 2400 characters. Be substantial: ' +
  'fully develop the subject with vivid, engaging prose. Do NOT stop short or write a brief caption. ' +
  'Output only the caption text, nothing else. Topic:';

/** Prompt for reading the creator's overlay caption off video frames, verbatim, while excluding
 *  handles / watermarks / burned-in speech subtitles / footage text. */
export function buildExtractionPrompt(frameCount: number): string {
  return (
    'You are reading frames from a social-media reel (TikTok/Instagram). Reels often have a caption the CREATOR ' +
    'overlaid on the video — usually text on the black letterbox bar above or below the video, or the body text of ' +
    'a tweet-style screenshot layout.\n\n' +
    'Your job: return that creator caption VERBATIM — exact wording, casing, punctuation, and line breaks.\n\n' +
    'STRICT exclusions — never include any of these in the caption:\n' +
    '- Usernames, @handles, display names, or verification badges (for tweet-style layouts return ONLY the tweet body text, never the name/handle row above it)\n' +
    '- Watermarks (TikTok/CapCut logos or usernames), channel logos, "link in bio" bugs\n' +
    '- Speech subtitles / closed captions burned into the footage\n' +
    '- News tickers, chyrons, headlines, or any other text that is part of the source footage itself\n' +
    '- UI elements, timestamps, view/follower counts\n\n' +
    `You are given ${frameCount} frame(s) from the SAME video. The creator overlay is identical and identically ` +
    'positioned in every frame; speech subtitles and footage text change between frames — use that to tell them apart.\n\n' +
    'Respond with JSON only, in exactly this shape: {"caption": "<verbatim caption text>"} — or {"caption": null} ' +
    'if the video has no creator overlay caption.'
  );
}
