// Thinking-content cleanup for the "Thought process" card.
//
// Provider thinking streams occasionally carry tag debris (reasoning-tag
// wrappers leaked by providers that use explicit <think>-style tags) and the
// card used to render the accumulated text verbatim. `sanitizeThinking`
// normalizes the text for human reading: strips reasoning-tag debris and
// invisible characters, and collapses whitespace runs. Applied at render time
// only — stores keep the raw stream for fidelity.

const REASONING_TAG = /<\/?\s*(?:think|thinking|thought|reasoning)\s*>/gi;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
const INVISIBLE = /[\u200b-\u200f\u00ad\ufeff]/g;

export function sanitizeThinking(raw: string): string {
  if (!raw) return "";
  let t = raw.replace(/\r\n?/g, "\n");
  t = t.replace(REASONING_TAG, "");
  t = t.replace(LINE_SEPARATORS, "\n");
  t = t.replace(INVISIBLE, "");
  t = t
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
