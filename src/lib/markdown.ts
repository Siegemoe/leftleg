import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
  });
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
