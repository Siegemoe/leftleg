import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Model-authored forms (fake credential prompts) and embedded frames have no
// legitimate use in a chat transcript — strip them at the sanitizer.
const FORBID_TAGS = [
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "iframe",
  "object",
  "embed",
];

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false });
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS,
  });
  return safeLinks(clean);
}

/**
 * Post-sanitize link hygiene. Clicks on rendered anchors are intercepted by
 * the delegated handler in App.svelte and routed to the OS browser — these
 * adjustments make a missed interception non-catastrophic: in-page jump
 * targets are neutralized (they would rewrite the webview URL), and every
 * anchor carries rel="noopener noreferrer" so no target page reaches
 * window.opener.
 */
function safeLinks(html: string): string {
  return html
    .replace(/<a\b([^>]*?)\shref="#[^"]*"/gi, '<a$1 href="about:blank#blocked"')
    .replace(/<a\b((?![^>]*\srel=)[^>]*)>/gi, '<a$1 rel="noopener noreferrer">');
}

/**
 * Repair incomplete markdown for live rendering: while text streams in,
 * fences and inline backticks arrive unbalanced and marked leaks raw markup.
 * Close any dangling fence/inline-code span so the partial render stays clean.
 */
export function renderStreamingMarkdown(src: string): string {
  // GFM fences: 0-3 leading spaces, 3 or more backticks.
  const fenceRe = /^ {0,3}`{3,}/gm;
  const fences = (src.match(fenceRe) ?? []).length;
  let patched = src;
  if (fences % 2 === 1) patched += "\n```";
  const ticks = (patched.match(/`/g) ?? []).length - (patched.match(fenceRe) ?? []).join("").length;
  if (ticks % 2 === 1) patched += "`";
  return renderMarkdown(patched);
}
