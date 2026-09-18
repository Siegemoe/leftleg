import { describe, expect, it } from "vitest";
import {
  ACTIONS, conflictingAction, effectiveBindings, formatBinding, matchKeybinding, parseCapture,
  type ActionId, type KeyEventLike,
} from "./keybindings";

// Minimal keydown stand-in — matchKeybinding/parseCapture only read these
// five properties off the event.
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
});

describe("parseCapture", () => {
  it("canonicalizes qualifying combos", () => {
    expect(parseCapture(ev({ key: "j", ctrlKey: true }))).toBe("Ctrl+J");
    expect(parseCapture(ev({ key: "7", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+7");
    expect(parseCapture(ev({ key: " ", ctrlKey: true }))).toBe("Ctrl+Space");
    expect(parseCapture(ev({ key: "J", metaKey: true }))).toBe("Ctrl+J");
  });

  it("rejects non-qualifying keys", () => {
    expect(parseCapture(ev({ key: "j" }))).toBeNull(); // bare letter — no ctrl/meta
    expect(parseCapture(ev({ key: "k", altKey: true, ctrlKey: true }))).toBeNull(); // alt chord
    expect(parseCapture(ev({ key: "Escape", ctrlKey: true }))).toBeNull(); // reserved for cancel
    expect(parseCapture(ev({ key: "Control", ctrlKey: true }))).toBeNull(); // lone modifier
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
