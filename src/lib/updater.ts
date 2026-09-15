// In-app update lifecycle. Downloads may happen while Pi works, but the final
// install boundary is serialized, rechecks all observable work, and shuts down
// every native Pi process before Windows hands control to NSIS.
import { get, writable } from "svelte/store";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import * as api from "./api";
import { collectUpdateInstallBlockers, updateInstallLock } from "./stores";

export type UpdateStatus = "idle" | "checking" | "downloading" | "ready" | "preparing" | "installing" | "error";

export const updateAvailable = writable<Update | null>(null);
export const updateStatus = writable<UpdateStatus>("idle");
export const updateError = writable<string>("");
export const updateProgress = writable<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });

export interface UpdateCheck {
  status: "idle" | "checking" | "current" | "available" | "failed";
  at: number | null;
  message: string;
}
export const updateCheck = writable<UpdateCheck>({ status: "idle", at: null, message: "" });

const CHECK_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
let checkInFlight: Promise<Update | null> | null = null;
let applyInFlight: Promise<void> | null = null;
let downloadedUpdate: Update | null = null;
let checkRevision = 0;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkFailureMessage(error: unknown): string {
  const raw = errorText(error);
  if (/\b404\b/.test(raw) || /not found/i.test(raw)) {
    return "No update feed published (404) — has a release been uploaded to GitHub?";
  }
  return `Update check failed: ${raw}`;
}

async function closeUpdate(update: Update | null): Promise<void> {
  if (!update) return;
  try { await update.close(); } catch { /* process exit and stale resources are harmless here */ }
}

async function replaceAvailable(update: Update | null): Promise<void> {
  const previous = get(updateAvailable);
  updateAvailable.set(update);
  if (previous && previous !== update) await closeUpdate(previous);
  if (downloadedUpdate && downloadedUpdate !== update) downloadedUpdate = null;
}

async function runCheck(): Promise<Update | null> {
  if (applyInFlight) return get(updateAvailable);
  const revision = ++checkRevision;
  updateStatus.set("checking");
  updateError.set("");
  updateCheck.set({ status: "checking", at: get(updateCheck).at, message: "" });
  try {
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    if (revision !== checkRevision) {
      await closeUpdate(update ?? null);
      return null;
    }
    await replaceAvailable(update ?? null);
    if (revision !== checkRevision) return null;
    updateStatus.set("idle");
    if (update) {
      updateCheck.set({ status: "available", at: Date.now(), message: `v${update.version} is available` });
    } else {
      updateCheck.set({ status: "current", at: Date.now(), message: "up to date" });
    }
    return update ?? null;
  } catch (error) {
    if (revision !== checkRevision) return null;
    await replaceAvailable(null);
    if (revision !== checkRevision) return null;
    const message = checkFailureMessage(error);
    updateError.set(message);
    updateStatus.set("error");
    updateCheck.set({ status: "failed", at: Date.now(), message });
    return null;
  }
}

/** Coalesce startup, Settings, and status-bar checks into one native request. */
export function checkForUpdates(): Promise<Update | null> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = runCheck().finally(() => { checkInFlight = null; });
  return checkInFlight;
}

function recordProgress(event: DownloadEvent): void {
  if (event.event === "Started") {
    updateProgress.set({ downloaded: 0, total: event.data.contentLength ?? null });
  } else if (event.event === "Progress") {
    updateProgress.update((value) => ({ ...value, downloaded: value.downloaded + event.data.chunkLength }));
  }
}

function blockerMessage(blockers: string[]): string {
  const visible = blockers.slice(0, 3);
  const remaining = blockers.length - visible.length;
  return `Update downloaded. Resolve before installing: ${visible.join("; ")}${remaining > 0 ? `; and ${remaining} more` : ""}.`;
}

async function runApplyUpdate(): Promise<void> {
  // A check may replace and close the old native resource. Finish it before
  // choosing the resource this installation owns.
  if (checkInFlight) await checkInFlight;
  const update = get(updateAvailable);
  if (!update) return;
  let nativePrepared = false;
  try {
    updateError.set("");
    if (downloadedUpdate !== update) {
      updateStatus.set("downloading");
      updateProgress.set({ downloaded: 0, total: null });
      await update.download(recordProgress, { timeout: DOWNLOAD_TIMEOUT_MS });
      downloadedUpdate = update;
      updateStatus.set("ready");
    }

    // Take the frontend lock before the synchronous blocker snapshot so new
    // work cannot enter between the safety check and native shutdown.
    updateInstallLock.set(true);
    const blockers = collectUpdateInstallBlockers();
    if (blockers.length > 0) {
      updateInstallLock.set(false);
      updateStatus.set("ready");
      updateError.set(blockerMessage(blockers));
      return;
    }

    updateStatus.set("preparing");
    await api.prepareForUpdate();
    nativePrepared = true;
    updateStatus.set("installing");
    // On Windows this launches NSIS and exits the process, so all state saving
    // and Pi shutdown must already be complete. Other platforms return and use
    // the explicit relaunch below.
    await update.install({ restartAfterInstall: true });
    await relaunch();
    // Relaunch normally terminates the process. If a platform implementation
    // returns, restore command availability instead of leaving a dead lock.
    await api.cancelUpdateShutdown();
    nativePrepared = false;
    updateInstallLock.set(false);
  } catch (error) {
    if (nativePrepared) {
      try { await api.cancelUpdateShutdown(); } catch { /* preserve the installer error */ }
    }
    updateInstallLock.set(false);
    updateStatus.set("error");
    updateError.set(`Update installation failed: ${errorText(error)}`);
  }
}

/** Serialize every install entry point; repeated clicks share one operation. */
export function applyUpdate(): Promise<void> {
  if (applyInFlight) return applyInFlight;
  applyInFlight = runApplyUpdate().finally(() => { applyInFlight = null; });
  return applyInFlight;
}

export async function dismissUpdate(): Promise<void> {
  if (applyInFlight) return;
  checkRevision++;
  const update = get(updateAvailable);
  downloadedUpdate = null;
  updateAvailable.set(null);
  updateError.set("");
  updateStatus.set("idle");
  updateCheck.set({ status: "idle", at: null, message: "" });
  await closeUpdate(update);
}

export function startupUpdateCheck(): void {
  void checkForUpdates();
}
