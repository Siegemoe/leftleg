import { describe, expect, it } from "vitest";
import { sanitizeThinking } from "./thinking";

// Tag literals are built from escapes so no tooling in the write pipeline can
// strip the literal tags out of this file.
const OPEN = "\x3cthink\x3e";
const CLOSE = "\x3c/think\x3e";
const OPEN_LONG = "\x3cthinking\x3e";
const CLOSE_LONG = "\x3c/thinking\x3e";

describe("sanitizeThinking", () => {
  it("removes reasoning tag pairs but keeps inner text", () => {
    expect(sanitizeThinking(`${OPEN}let me check the file.${CLOSE}`)).toBe(
      "let me check the file.",
    );
  });

  it("removes stray unmatched tags anywhere (both spellings)", () => {
    expect(sanitizeThinking(`foo${OPEN}\n${CLOSE}ar${OPEN_LONG}x${CLOSE_LONG}`)).toBe(
      "foo\narx",
    );
  });

  it("collapses whitespace runs and trims", () => {
    expect(sanitizeThinking("  a  \n\n\n\n\nb  ")).toBe("a\n\nb");
  });

  it("normalizes CRLF and drops invisible characters", () => {
    expect(sanitizeThinking(`a\r\nb${"\u200b"}c${"\u00ad"}d${"\ufeff"}`)).toBe("a\nbcd");
  });

  it("passes plain text through unchanged", () => {
    const t = "Step 1: read the file\nStep 2: edit it";
    expect(sanitizeThinking(t)).toBe(t);
  });

  it("handles empty input", () => {
    expect(sanitizeThinking("")).toBe("");
  });
});
