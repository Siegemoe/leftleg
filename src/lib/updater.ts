// In-app update checking via Tauri's updater plugin.
// Startup check is non-blocking and deferred: updates are NEVER downloaded or
// installed while the agent is active (turn-safe deferral, same contract as
// the rest of Leftleg's lifecycle handling).
import { writable, get } from "svelte/store";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { streaming } from "./stores";

export const updateAvailable = writable<Update | null>(null);
export const updateStatus = writable<"idle" | "checking" | "downloading" | "ready" | "error">("idle");
export const updateError = writable<string>("");

/**
 * Durable, user-visible record of the last update check. Unlike
 * `updateAvailable` (null both when current and when the check failed), this
 * distinguishes "up to date" from "could not check" so a missing or broken
 * update feed is never silently invisible.
 */
export interface UpdateCheck {
  status: "idle" | "checking" | "current" | "available" | "failed";
  /** Wall-clock time of the last completed check, or null. */
  at: number | null;
  /** Human-readable summary for tooltips and the settings panel. */
  message: string;
}
export const updateCheck = writable<UpdateCheck>({ status: "idle", at: null, message: "" });

/** Map a failed check to something a user can act on (e.g. a missing feed). */
function checkFailureMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/\b404\b/.test(raw) || /not found/i.test(raw)) {
    return "No update feed published (404) — has a release been uploaded to GitHub?";
  }
  return `Update check failed: ${raw}`;
}

/** Check for updates. Resolves null when already current. */
export async function checkForUpdates(): Promise<Update | null> {
  updateStatus.set("checking");
  updateCheck.set({ status: "checking", at: get(updateCheck).at, message: "" });
  try {
    const update = await check();
    updateAvailable.set(update ?? null);
    updateStatus.set("idle");
    if (update) {
      updateCheck.set({ status: "available", at: Date.now(), message: `v${update.version} is ready to install` });
    } else {
      updateCheck.set({ status: "current", at: Date.now(), message: "up to date" });
    }
    return update ?? null;
  } catch (e) {
    const message = checkFailureMessage(e);
    updateError.set(message);
    updateStatus.set("error");
    updateCheck.set({ status: "failed", at: Date.now(), message });
    return null;
  }
}

/** Download + install the pending update, then relaunch. Turn-safe: refuses
 * while the agent is streaming; the banner stays up so the user can install
 * once the turn settles. */
export async function applyUpdate(): Promise<void> {
  const update = get(updateAvailable);
  if (!update) return;
  if (get(streaming)) {
    updateError.set("Agent is working — install this update after the turn settles.");
    return;
  }
  try {
    updateStatus.set("downloading");
    await update.downloadAndInstall();
    updateStatus.set("ready");
    await relaunch();
  } catch (e) {
    updateStatus.set("error");
    updateError.set(e instanceof Error ? e.message : String(e));
  }
}

/** Startup auto-check — fire-and-forget; the banner renders when available,
 * and failures surface in the status bar / settings, not as crashes. */
export function startupUpdateCheck(): void {
  void checkForUpdates().catch(() => { /* failure already recorded in updateCheck */ });
}
