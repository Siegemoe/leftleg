import { beforeEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("./api", () => ({
  piIntegrityReport: vi.fn().mockResolvedValue({ extensions: [] }),
  runPiManager: vi.fn(),
  piRequest: vi.fn(),
  piStart: vi.fn(),
  pendingGuiWriteCount: vi.fn().mockReturnValue(0),
  writeGuiState: vi.fn().mockResolvedValue(undefined),
  prepareForUpdate: vi.fn(),
  cancelUpdateShutdown: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import * as api from "./api";
import { runStartupPiUpdate } from "./pi-update";
import { connected, projectDir, sendPrompt, switchToProject, updateInstallLock } from "./stores";
import { applyUpdate, dismissUpdate, updateAvailable } from "./updater";

beforeEach(() => {
  vi.clearAllMocks();
  updateInstallLock.set(false);
  connected.set(true);
  projectDir.set("C:\\work\\project");
});

it("blocks prompts, navigation, and app installation for the entire Pi update", async () => {
  let failUpdate!: (error: Error) => void;
  vi.mocked(api.runPiManager).mockImplementation(() => new Promise((_, reject) => { failUpdate = reject; }));
  runStartupPiUpdate();
  await vi.waitFor(() => expect(api.runPiManager).toHaveBeenCalledOnce());
  const heldDuringUpdate = get(updateInstallLock);
  const prompt = await sendPrompt("start a turn", []);
  await switchToProject("C:\\work\\other");
  const appUpdate = {
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  updateAvailable.set(appUpdate as never);
  await applyUpdate();
  const heldAfterInstallAttempt = get(updateInstallLock);
  // Always settle the deferred runner, including when an assertion would fail.
  failUpdate(new Error("mock update failed"));
  await vi.waitFor(() => expect(get(updateInstallLock)).toBe(false));
  await dismissUpdate();

  expect(heldDuringUpdate).toBe(true);
  expect(prompt.ok).toBe(false);
  expect(api.piRequest).not.toHaveBeenCalled();
  expect(api.piStart).not.toHaveBeenCalled();
  expect(api.prepareForUpdate).not.toHaveBeenCalled();
  expect(appUpdate.install).not.toHaveBeenCalled();
  expect(heldAfterInstallAttempt).toBe(true);
});
