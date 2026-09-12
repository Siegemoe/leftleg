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
  const fences = (src.match(/^```/gm) ?? []).length;
  let patched = src;
  if (fences % 2 === 1) patched += "\n```";
  const ticks = (patched.match(/`/g) ?? []).length - (patched.match(/^```/gm) ?? []).join("").length;
  if (ticks % 2 === 1) patched += "`";
  return renderMarkdown(patched);
}
