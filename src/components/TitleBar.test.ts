import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  applyUpdate: vi.fn(),
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn().mockResolvedValue("/app") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.openPath, openUrl: mocks.openUrl }));
vi.mock("../lib/updater", () => ({
  checkForUpdates: mocks.checkForUpdates,
  applyUpdate: mocks.applyUpdate,
  updateAvailable: writable(null),
  updateStatus: writable("idle"),
  updateCheck: writable({ status: "idle", at: null, message: "" }),
}));

import TitleBar from "./TitleBar.svelte";
import StatusBar from "./StatusBar.svelte";
import { settingsOpen, settingsProject } from "../lib/stores";
import { updateAvailable, updateCheck, updateStatus } from "../lib/updater";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "0.2.3");
  settingsOpen.set(false);
  settingsProject.set(null);
  updateAvailable.set(null);
  updateStatus.set("idle");
  updateCheck.set({ status: "idle", at: null, message: "" });
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("title bar", () => {
  it("opens File settings in general scope after project settings were used", () => {
    settingsProject.set("/old-project");
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "File")!.click();
    flushSync();
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Settings…")!.click();
    flushSync();

    let scope: string | null | undefined;
    settingsProject.subscribe((value) => { scope = value; })();
    expect(scope).toBeNull();
  });
});

describe("status bar updater state", () => {
  it("offers installation after the download is ready", () => {
    updateAvailable.set({ version: "0.3.0" } as never);
    updateStatus.set("ready");
    updateCheck.set({ status: "available", at: Date.now(), message: "v0.3.0 is available" });
    instance = mount(StatusBar, { target: document.body });
    flushSync();

    const button = document.body.querySelector<HTMLButtonElement>("button.upd")!;
    expect(button.textContent).toContain("update downloaded — install");
    expect(button.disabled).toBe(false);
  });
});
