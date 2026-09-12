import { describe, expect, it } from "vitest";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders inline formatting", () => {
    const html = renderMarkdown("a **bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = 1;");
  });

  it("breaks on single newlines (breaks: true)", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toContain("<br");
  });

  it("strips <script> injection", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> world');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert(1)");
  });

  it("strips javascript: link targets", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).toContain("<a");
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("preserves target attributes (ADD_ATTR)", () => {
    const html = renderMarkdown('<a href="https://example.com" target="_blank">x</a>');
    expect(html).toContain('target="_blank"');
  });
});

describe("renderStreamingMarkdown", () => {
  it("closes a dangling fence so partial output stays inside the code block", () => {
    // mid-stream: one ``` opened, not yet closed. Without repair the rest of the
    // document would be swallowed into the fence (or leak as raw text).
    const html = renderStreamingMarkdown("text before\n```ts\nconst x = 1;\nmore coming");
    expect(html).toContain("<p>text before</p>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x = 1;");
    expect(html).toContain("more coming");
  });

  it("closes a dangling inline backtick mid-stream", () => {
    const html = renderStreamingMarkdown("using `code now");
    expect(html).toContain("<code>code now</code>");
  });

  it("leaves balanced markdown untouched", () => {
    const html = renderStreamingMarkdown("a `code` span\n\n```js\nvar y;\n```\n");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("var y;");
  });
});
