import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, writable } from "svelte/store";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn().mockResolvedValue(undefined),
  prepareForUpdate: vi.fn().mockResolvedValue(1),
  cancelUpdateShutdown: vi.fn().mockResolvedValue(undefined),
  blockers: vi.fn<() => string[]>().mockReturnValue([]),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("./api", () => ({
  prepareForUpdate: mocks.prepareForUpdate,
  cancelUpdateShutdown: mocks.cancelUpdateShutdown,
}));
vi.mock("./stores", () => ({
  collectUpdateInstallBlockers: mocks.blockers,
  updateInstallLock: writable(false),
}));

import {
  applyUpdate, checkForUpdates, dismissUpdate, updateAvailable, updateError, updateStatus, updateCheck,
} from "./updater";
import { updateInstallLock } from "./stores";

function fakeUpdate() {
  return {
    version: "0.3.0",
    download: vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 100 } });
      onEvent({ event: "Finished" });
    }),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  mocks.check.mockReset();
  mocks.blockers.mockReset().mockReturnValue([]);
  mocks.prepareForUpdate.mockReset().mockResolvedValue(1);
  mocks.cancelUpdateShutdown.mockReset().mockResolvedValue(undefined);
  mocks.relaunch.mockReset().mockResolvedValue(undefined);
  updateInstallLock.set(false);
  updateError.set("");
  updateStatus.set("idle");
});

afterEach(async () => {
  await dismissUpdate();
});

describe("safe update installation", () => {
  it("waits for an ongoing check before selecting the update to install", async () => {
    const previous = fakeUpdate();
    const fresh = fakeUpdate();
    updateAvailable.set(previous as never);
    let finishCheck!: (value: unknown) => void;
    mocks.check.mockImplementation(() => new Promise((resolve) => { finishCheck = resolve; }));
    const checking = checkForUpdates();
    const applying = applyUpdate();
    const downloadedBeforeCheck = previous.download.mock.calls.length;
    finishCheck(fresh);
    await Promise.all([checking, applying]);

    expect(downloadedBeforeCheck).toBe(0);
    expect(previous.install).not.toHaveBeenCalled();
    expect(fresh.install).toHaveBeenCalledOnce();
    expect(fresh.close).not.toHaveBeenCalled();
  });

  it("keeps a dismissed update dismissed when a pending check finishes", async () => {
    const previous = fakeUpdate();
    const fresh = fakeUpdate();
    updateAvailable.set(previous as never);
    let finishCheck!: (value: unknown) => void;
    mocks.check.mockImplementation(() => new Promise((resolve) => { finishCheck = resolve; }));
    const checking = checkForUpdates();
    await dismissUpdate();
    finishCheck(fresh);
    await checking;

    expect(get(updateAvailable)).toBeNull();
    expect(get(updateCheck).status).toBe("idle");
    expect(fresh.close).toHaveBeenCalledOnce();
  });

  it("downloads but refuses installation when work appears before the final boundary", async () => {
    const update = fakeUpdate();
    updateAvailable.set(update as never);
    mocks.blockers.mockReturnValue(["background has an active agent turn"]);

    await applyUpdate();

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.prepareForUpdate).not.toHaveBeenCalled();
    expect(get(updateStatus)).toBe("ready");
    expect(get(updateInstallLock)).toBe(false);
    expect(get(updateError)).toContain("background has an active agent turn");
  });

  it("stops native Pi processes before invoking the installer", async () => {
    const update = fakeUpdate();
    updateAvailable.set(update as never);
    const order: string[] = [];
    mocks.prepareForUpdate.mockImplementation(async () => { order.push("prepare"); return 2; });
    update.install.mockImplementation(async () => { order.push("install"); });

    await applyUpdate();

    expect(order).toEqual(["prepare", "install"]);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.cancelUpdateShutdown).toHaveBeenCalledOnce();
  });

  it("coalesces repeated install clicks into one download and install", async () => {
    let finishDownload!: () => void;
    const update = fakeUpdate();
    update.download.mockImplementation(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
    updateAvailable.set(update as never);

    const first = applyUpdate();
    const second = applyUpdate();
    expect(second).toBe(first);
    finishDownload();
    await Promise.all([first, second]);

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.prepareForUpdate).toHaveBeenCalledOnce();
  });

  it("releases both locks if launching the installer fails", async () => {
    const update = fakeUpdate();
    update.install.mockRejectedValue(new Error("ShellExecute failed"));
    updateAvailable.set(update as never);

    await applyUpdate();

    expect(mocks.cancelUpdateShutdown).toHaveBeenCalledOnce();
    expect(get(updateInstallLock)).toBe(false);
    expect(get(updateStatus)).toBe("error");
    expect(get(updateError)).toContain("ShellExecute failed");
  });
});
