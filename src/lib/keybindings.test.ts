import { describe, expect, it } from "vitest";
import {
  ACTIONS, conflictingAction, effectiveBindings, formatBinding, matchKeybinding, parseCapture,
  type ActionId, type KeyEventLike,
} from "./keybindings";

// Minimal keydown stand-in — matchKeybinding/parseCapture only read these
// properties off the event.
const ev = (over: Partial<KeyEventLike>): KeyEventLike =>
  ({ key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

const defaults = effectiveBindings({});

describe("matchKeybinding", () => {
  it("matches ctrl and meta equivalently", () => {
    expect(matchKeybinding(ev({ key: "n", ctrlKey: true }), defaults)).toBe("newSession");
    expect(matchKeybinding(ev({ key: "n", metaKey: true }), defaults)).toBe("newSession");
  });

  it("rejects modifierless keys and alt chords", () => {
    expect(matchKeybinding(ev({ key: "n" }), defaults)).toBeNull();
    expect(matchKeybinding(ev({ key: "n", altKey: true, ctrlKey: true }), defaults)).toBeNull();
  });

  it("distinguishes shift", () => {
    expect(matchKeybinding(ev({ key: "n", ctrlKey: true, shiftKey: true }), defaults)).toBe("newProject");
    // Shift is not free: Ctrl+B with shift held owns no action.
    expect(matchKeybinding(ev({ key: "b", ctrlKey: true, shiftKey: true }), defaults)).toBeNull();
  });

  it("compares keys case-insensitively and skips unbound and unknown entries", () => {
    expect(matchKeybinding(ev({ key: "N", ctrlKey: true }), defaults)).toBe("newSession");
    // A null entry never matches; a bound action takes over the chord.
    const rebound = { ...defaults, newSession: null, openArtifacts: "Ctrl+J" };
    expect(matchKeybinding(ev({ key: "j", ctrlKey: true }), rebound)).toBe("openArtifacts");
    // Unknown action ids in the map are ignored, not matched.
    const junk = { ...defaults, bogus: "Ctrl+J" } as Record<ActionId, string | null>;
    expect(matchKeybinding(ev({ key: "j", ctrlKey: true }), junk)).toBeNull();
  });

  it("round-trips the plus key through capture and matching", () => {
    // "Ctrl++" can't survive parseBinding's "+"-split; the canonical
    // "Ctrl+Plus" form does, and a real "+" keydown matches it.
    const rebound = { ...defaults, newSession: "Ctrl+Plus" };
    expect(matchKeybinding(ev({ key: "+", ctrlKey: true }), rebound)).toBe("newSession");
  });

  it("matches Latin-letter bindings by physical key under a non-Latin layout", () => {
    // A non-Latin layout reports e.key as the local glyph ("т" on Russian for
    // the N key) while e.code still names the physical key — the letter
    // binding must fire on the code, not the glyph.
    expect(matchKeybinding(ev({ key: "т", code: "KeyN", ctrlKey: true }), defaults)).toBe("newSession");
    expect(matchKeybinding(ev({ key: "и", code: "KeyB", ctrlKey: true }), defaults)).toBe("toggleSidebar");
    expect(matchKeybinding(ev({ key: "т", code: "KeyN", ctrlKey: true, shiftKey: true }), defaults)).toBe("newProject");
    // e.key stays authoritative in the other direction: a glyph that happens
    // to match never needs the code to agree.
    expect(matchKeybinding(ev({ key: "n", code: "KeyM", ctrlKey: true }), defaults)).toBe("newSession");
    // A glyph that matches neither key nor physical code is not a match.
    expect(matchKeybinding(ev({ key: "и", code: "KeyB", ctrlKey: true, shiftKey: true }), defaults)).toBeNull();
    // Punctuation keeps e.key-only matching: a code carrying the same glyph's
    // physical key must not substitute for a binding the key can't match.
    const rebound = { ...defaults, newSession: "Ctrl+Plus" };
    expect(matchKeybinding(ev({ key: "ю", code: "Equal", ctrlKey: true }), rebound)).toBeNull();
  });
});

describe("parseCapture", () => {
  it("canonicalizes qualifying combos", () => {
    expect(parseCapture(ev({ key: "j", ctrlKey: true }))).toBe("Ctrl+J");
    expect(parseCapture(ev({ key: "7", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+7");
    expect(parseCapture(ev({ key: " ", ctrlKey: true }))).toBe("Ctrl+Space");
    expect(parseCapture(ev({ key: "+", ctrlKey: true }))).toBe("Ctrl+Plus");
    expect(parseCapture(ev({ key: "J", metaKey: true }))).toBe("Ctrl+J");
  });

  it("rejects non-qualifying keys", () => {
    expect(parseCapture(ev({ key: "j" }))).toBeNull(); // bare letter — no ctrl/meta
    expect(parseCapture(ev({ key: "k", altKey: true, ctrlKey: true }))).toBeNull(); // alt chord
    expect(parseCapture(ev({ key: "Escape", ctrlKey: true }))).toBeNull(); // reserved for cancel
    expect(parseCapture(ev({ key: "Control", ctrlKey: true }))).toBeNull(); // lone modifier
    expect(parseCapture(ev({ key: "Dead", ctrlKey: true }))).toBeNull(); // IME/dead-key token
    expect(parseCapture(ev({ key: "Process", ctrlKey: true }))).toBeNull(); // IME composition
    expect(parseCapture(ev({ key: "Unidentified", ctrlKey: true }))).toBeNull(); // unknown key
  });
});

describe("formatBinding", () => {
  it("normalizes modifier order and key casing", () => {
    expect(formatBinding("Shift+Ctrl+n")).toBe("Ctrl+Shift+N");
    expect(formatBinding("ctrl+space")).toBe("Ctrl+Space");
    expect(formatBinding("Ctrl+f5")).toBe("Ctrl+F5");
  });

  it("passes unrecognized strings through unchanged", () => {
    // Alt-only bindings never register, so a stray one stays visible.
    expect(formatBinding("Alt+K")).toBe("Alt+K");
    expect(formatBinding("")).toBe("");
  });
});

describe("effectiveBindings and conflicts", () => {
  it("layers overrides over defaults, keeps listed-but-unbound null", () => {
    const eff = effectiveBindings({ openDiff: "Ctrl+D" });
    expect(eff.newSession).toBe("Ctrl+N");
    expect(eff.openDiff).toBe("Ctrl+D");
    expect(eff.openStatus).toBeNull();
    expect(ACTIONS.find((a) => a.id === "newProject")?.label).toBe("New project");
  });

  it("finds the owning action for a duplicate, excluding the captured row", () => {
    const eff = effectiveBindings({ openArtifacts: "Ctrl+A" });
    expect(conflictingAction(eff, "Ctrl+A", "openStatus")).toBe("openArtifacts");
    expect(conflictingAction(eff, "Ctrl+A", "openArtifacts")).toBeNull(); // self excluded
    expect(conflictingAction(eff, "ctrl+n", "openStatus")).toBe("newSession"); // normalized compare
    expect(conflictingAction(eff, "Ctrl+K", "openStatus")).toBeNull();
  });
});
