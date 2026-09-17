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
// ANSI escape debris (truecolor SGR codes and friends) that provider streams
// occasionally leak into thinking text.
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-9;:?]*[a-zA-Z]/g;
const ANSI_ESC = /\x1b[@-Z\\-_]/g;
// The same SGR debris after the ESC byte has been lost somewhere upstream.
const ANSI_BARE = /\[(?:38|48);2;\d{1,3};\d{1,3};\d{1,3}m|\[\d{1,3}m/g;

export function sanitizeThinking(raw: string): string {
  if (!raw) return "";
  let t = raw.replace(/\r\n?/g, "\n");
  t = t.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_ESC, "").replace(ANSI_BARE, "");
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
