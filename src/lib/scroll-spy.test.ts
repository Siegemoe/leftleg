import { describe, expect, it } from "vitest";
import { pickActivePrompt } from "./scroll-spy";

// Anchors in document order (top-to-bottom), tops relative to the page.
const anchors = (tops: number[]) => tops.map((top, i) => ({ id: `p${i}`, top }));

describe("pickActivePrompt", () => {
  it("returns null with no anchors", () => {
    expect(pickActivePrompt([], 0, false)).toBeNull();
  });

  it("marks the last prompt scrolled past the threshold", () => {
    // viewportTop 0, threshold 120: p0 (top 50) and p1 (top 100) crossed,
    // p2 (top 300) not.
    expect(pickActivePrompt(anchors([50, 100, 300]), 0, false)).toBe("p1");
  });

  it("keeps a prompt active at exactly the threshold", () => {
    expect(pickActivePrompt(anchors([120, 400]), 0, false)).toBe("p0");
  });

  it("returns null when no prompt has crossed the threshold", () => {
    expect(pickActivePrompt(anchors([121, 400]), 0, false)).toBeNull();
  });

  it("activates the last prompt at bottom even when its turn is short", () => {
    // At max scroll the final short anchor sits below the threshold — the
    // bottom rule (not the spy rule) must win, or a clicked last tick
    // de-highlights itself.
    expect(pickActivePrompt(anchors([0, 130, 900]), 0, true)).toBe("p2");
  });

  it("prefers the spy rule when not at bottom", () => {
    // p0 and p1 crossed the threshold, p2 didn't — spy rule picks p1 even
    // though the bottom rule would say p2.
    expect(pickActivePrompt(anchors([0, 100, 900]), 0, false)).toBe("p1");
  });
});
