import { get, writable } from "svelte/store";
import type { ComposerAttachment } from "./prompt-message";

function blankDraft() {
  return writable({
    text: "",
    sending: false,
    lastExtensionNonce: 0,
    attachments: [] as ComposerAttachment[],
  });
}
const drafts = new Map<string, ReturnType<typeof blankDraft>>();
// Shared fallback so a falsy key never yields a fresh store per call.
const fallbackDraft = blankDraft();
/** Unsent GUI drafts, in memory only, scoped to project + session. */
export function composerDraftFor(key: string) {
  if (!key) return fallbackDraft;
  let draft = drafts.get(key);
  if (!draft) {
    draft = blankDraft();
    drafts.set(key, draft);
  }
  return draft;
}

/** Drop this project's per-session drafts that hold nothing. Pure GC —
 * composerDraftFor recreates entries on demand — run it when a session's
 * key can no longer be revisited (project switch, process exit) so the map
 * doesn't accumulate one entry per session ever visited. Never touches the
 * shared fallback / "startup project" drafts, and never drops a draft that
 * still has text, attachments, or an in-flight send. */
export function pruneEmptyComposerDrafts(projectDir: string) {
  if (!projectDir) return;
  const prefix = `${projectDir}:`;
  for (const [key, store] of drafts) {
    if (!key.startsWith(prefix)) continue;
    const d = get(store);
    if (!d.sending && !d.text.trim() && d.attachments.length === 0) drafts.delete(key);
  }
}

export interface ComposerDraftBlocker {
  key: string;
  text: boolean;
  attachments: number;
  sending: boolean;
}

/** Snapshot GUI-owned input that would be lost when the updater exits. */
export function composerDraftBlockers(): ComposerDraftBlocker[] {
  const entries = [...drafts.entries(), ["current session", fallbackDraft] as const];
  const blockers: ComposerDraftBlocker[] = [];
  for (const [key, store] of entries) {
    const draft = get(store);
    if (!draft.sending && !draft.text.trim() && draft.attachments.length === 0) continue;
    blockers.push({
      key,
      text: draft.text.trim().length > 0,
      attachments: draft.attachments.length,
      sending: draft.sending,
    });
  }
  return blockers;
}
