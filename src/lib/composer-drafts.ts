import { writable } from "svelte/store";
import type { ComposerAttachment } from "./prompt-message";

function blankDraft() { return writable({ text: "", sending: false, lastExtensionNonce: 0, attachments: [] as ComposerAttachment[] }); }
const drafts = new Map<string, ReturnType<typeof blankDraft>>();
// Shared fallback so a falsy key never yields a fresh store per call.
const fallbackDraft = blankDraft();
/** Unsent GUI drafts, in memory only, scoped to project + session. */
export function composerDraftFor(key: string) {
  if (!key) return fallbackDraft;
  let draft = drafts.get(key);
  if (!draft) { draft = blankDraft(); drafts.set(key, draft); }
  return draft;
}
