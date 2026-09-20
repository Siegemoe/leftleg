// Pure key-binding registry for Leftleg's webview accelerators. Deliberately
// store-free (no svelte imports) so it stays unit-testable — stores.ts owns
// the user-override store (the `keybindings` writable) and persists it in
// GUI state; TitleBar dispatches through matchKeybinding.

/** Every action that can carry a keyboard shortcut. */
export type ActionId =
  | "newSession"
  | "newProject"
  | "toggleSidebar"
  | "openArtifacts"
  | "openStatus"
  | "openDiff"
  | "openFiles"
  | "openSubagents"
  | "openBrowser"
  | "openTerminal"
  | "toggleRightPanel"
  | "focusSearch"
  | "openSettings"
  | "cycleThinking"
  | "clearQueue"
  | "retryFailed"
  | "cycleTheme"
  | "goHome";

export interface ActionDef {
  id: ActionId;
  label: string;
  /** Canonical default binding ("Ctrl+N"), or null when listed but unbound. */
  defaultBinding: string | null;
}

/** Registry order is also dispatch order: first match wins. Defaults follow
 * the conventions researched in docs/KEYBINDINGS-RESEARCH.md: dock digits
 * ride the browser-trained "Ctrl+digit jumps to thing N" muscle memory (free
 * in a desktop webview), Ctrl+K is the chat-app quick-switcher, Ctrl+, the
 * cross-tool settings chord. Deliberately unowned: Ctrl+J (WebView2's own
 * Downloads accelerator), Ctrl+R/F5 (reload), Ctrl+W (close-tab, needs a
 * gate we don't have), the native edit family, and Esc (reserved for the
 * cancel ladder). */
export const ACTIONS: readonly ActionDef[] = [
  { id: "newSession", label: "New session", defaultBinding: "Ctrl+N" },
  { id: "newProject", label: "New project", defaultBinding: "Ctrl+Shift+N" },
  { id: "toggleSidebar", label: "Toggle sidebar", defaultBinding: "Ctrl+B" },
  { id: "openStatus", label: "Open Status dock", defaultBinding: "Ctrl+1" },
  { id: "openArtifacts", label: "Open Artifacts dock", defaultBinding: "Ctrl+2" },
  { id: "openSubagents", label: "Open Subagents dock", defaultBinding: "Ctrl+3" },
  { id: "openDiff", label: "Open Diff dock", defaultBinding: "Ctrl+4" },
  { id: "openBrowser", label: "Open Browser dock", defaultBinding: "Ctrl+5" },
  { id: "openTerminal", label: "Open Terminal dock", defaultBinding: "Ctrl+6" },
  { id: "openFiles", label: "Open Files dock", defaultBinding: "Ctrl+7" },
  { id: "toggleRightPanel", label: "Toggle right panel", defaultBinding: "Ctrl+Shift+B" },
  { id: "focusSearch", label: "Search sessions", defaultBinding: "Ctrl+K" },
  { id: "openSettings", label: "Open settings", defaultBinding: "Ctrl+," },
  { id: "cycleThinking", label: "Cycle thinking level", defaultBinding: "Ctrl+Shift+T" },
  { id: "clearQueue", label: "Clear queued messages", defaultBinding: null },
  { id: "retryFailed", label: "Retry last failed prompt", defaultBinding: null },
  { id: "cycleTheme", label: "Cycle theme", defaultBinding: null },
  { id: "goHome", label: "Back to start view", defaultBinding: null },
];

export const ACTION_IDS: readonly ActionId[] = ACTIONS.map((a) => a.id);

/** null = listed but unbound by default (still assignable in Settings). */
export const DEFAULT_BINDINGS: Record<ActionId, string | null> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.defaultBinding]),
) as Record<ActionId, string | null>;

/** Bare modifier toggles and lock keys never form a binding on their own,
 * and IME/dead-key tokens the webview synthesizes never name a real key. */
const NON_KEY_NAMES = new Set([
  "Control",
  "Shift",
  "Meta",
  "Alt",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);

/** Canonical key token: single characters uppercase, " " becomes "Space",
 * "+" (or the word "plus") becomes "Plus" so it survives parseBinding's
 * "+"-split round-trip, named keys pass through. Shared by parsing,
 * formatting, and matching so a stored "Ctrl+Space" matches a keydown of
 * e.key === " ". */
function keyToken(key: string): string {
  if (key === " " || key.toLowerCase() === "space") return "Space";
  if (key === "+" || key.toLowerCase() === "plus") return "Plus";
  if (key.length === 1) return key.toUpperCase();
  return /^f\d{1,2}$/.test(key) ? key.toUpperCase() : key;
}

interface ParsedBinding {
  ctrl: boolean;
  shift: boolean;
  key: string;
}

/** Tolerant parse of a stored binding. Requires a Ctrl/Cmd modifier (every
 * binding needs one, mirroring the accelerators this registry replaces) and
 * rejects Alt chords. Returns null when the string cannot be a binding. */
function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: ParsedBinding = { ctrl: false, shift: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "meta" || lower === "cmd")
      out.ctrl = true;
    else if (lower === "shift") out.shift = true;
    else if (lower === "alt") return null;
    else out.key = keyToken(part);
  }
  if (!out.ctrl || !out.key) return null;
  return out;
}

/** Canonical display form ("Ctrl+Shift+N"). Modifier order and key casing are
 * normalized; unrecognized input passes through unchanged so a malformed
 * saved value stays visible rather than silently disappearing. */
export function formatBinding(binding: string): string {
  const parsed = parseBinding(binding);
  if (!parsed) return binding;
  const parts = ["Ctrl"];
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}

/** Effective bindings = user overrides over the defaults. A null entry is
 * listed-but-unbound: it never matches and shows no menu hint. */
export function effectiveBindings(
  overrides: Partial<Record<ActionId, string>>,
): Record<ActionId, string | null> {
  const out = {} as Record<ActionId, string | null>;
  for (const a of ACTIONS) out[a.id] = overrides[a.id] ?? DEFAULT_BINDINGS[a.id];
  return out;
}

/** Event shape needed for matching — a real KeyboardEvent satisfies it, and
 * tests can pass plain objects. `code` is optional: when present, Latin-letter
 * bindings also match the physical key so shortcuts survive non-Latin
 * keyboard layouts (where e.key is the local glyph, but e.code stays "KeyN"). */
export type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> & { code?: string };

/** Match a keydown against the effective bindings. Requires Ctrl or Cmd
 * (treated as equivalent — the app is Windows-first but webview Cmd users
 * keep working), excludes Alt, distinguishes Shift, and compares e.key
 * case-insensitively. Latin-letter bindings additionally match the physical
 * key (e.code "KeyN") so Ctrl+N keeps firing under a non-Latin layout, where
 * the OS reports e.key as the local glyph; punctuation has no reliable code
 * mapping and keeps matching on e.key alone. Entries that are absent/null/
 * unknown are ignored. Returns the first match in registry order, or null. */
export function matchKeybinding(
  e: KeyEventLike,
  bindings: Partial<Record<ActionId, string | null>>,
): ActionId | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (!e.key) return null;
  const key = keyToken(e.key).toLowerCase();
  const codeLetter = e.code ? (/^Key([A-Z])$/.exec(e.code)?.[1] ?? null) : null;
  for (const a of ACTIONS) {
    const binding = bindings[a.id];
    if (!binding) continue;
    const parsed = parseBinding(binding);
    if (!parsed || parsed.shift !== e.shiftKey) continue;
    if (parsed.key.toLowerCase() === key) return a.id;
    // Physical-key fallback: the binding's key is a single Latin letter and
    // the event's code names that same physical key.
    if (codeLetter !== null && /^[A-Z]$/.test(parsed.key) && parsed.key === codeLetter) return a.id;
  }
  return null;
}

/** Normalize a captured keydown into a canonical binding string, or null when
 * the key cannot qualify: bare modifiers, Escape (reserved for cancel), keys
 * without Ctrl/Cmd, and Alt chords. Mirrors matchKeybinding's qualification
 * rules so anything capturable is matchable. */
export function parseCapture(e: KeyEventLike): string | null {
  if (!e.key) return null;
  if (e.key === "Escape") return null;
  if (e.altKey) return null;
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (NON_KEY_NAMES.has(e.key)) return null;
  const parts = ["Ctrl"]; // meta is canonicalized to Ctrl (matched equivalently)
  if (e.shiftKey) parts.push("Shift");
  parts.push(keyToken(e.key));
  return parts.join("+");
}

/** Which action (other than `exclude`) already owns `binding` in the effective
 * map — the duplicate warning behind the Settings capture UI. Comparison is
 * normalized, so "ctrl+n" and "Ctrl+N" count as the same binding. */
export function conflictingAction(
  bindings: Partial<Record<ActionId, string | null>>,
  binding: string,
  exclude: ActionId,
): ActionId | null {
  const want = formatBinding(binding).toLowerCase();
  if (!want) return null;
  for (const a of ACTIONS) {
    if (a.id === exclude) continue;
    const have = bindings[a.id];
    if (have && formatBinding(have).toLowerCase() === want) return a.id;
  }
  return null;
}
