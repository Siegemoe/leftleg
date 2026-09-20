import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  applyUpdate: vi.fn(),
  openPathLocal: vi.fn(),
  openUrl: vi.fn(),
  quitApp: vi.fn(),
  win: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mocks.win,
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn().mockResolvedValue("/app") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../lib/api", () => ({ openPathLocal: mocks.openPathLocal, quitApp: mocks.quitApp }));
vi.mock("../lib/updater", () => ({
  checkForUpdates: mocks.checkForUpdates,
  applyUpdate: mocks.applyUpdate,
  updateAvailable: writable(null),
  updateStatus: writable("idle"),
  updateCheck: writable({ status: "idle", at: null, message: "" }),
}));

import TitleBar from "./TitleBar.svelte";
import { settingsOpen, settingsProject } from "../lib/stores";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "0.2.3");
  settingsOpen.set(false);
  settingsProject.set(null);
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

    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "File")!
      .click();
    flushSync();
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Settings…")!
      .click();
    flushSync();

    let scope: string | null | undefined;
    settingsProject.subscribe((value) => {
      scope = value;
    })();
    expect(scope).toBeNull();
  });

  it("File → Exit quits the app; the X button parks via win.close()", () => {
    mocks.quitApp.mockClear();
    mocks.win.close.mockClear();
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "File")!
      .click();
    flushSync();
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Exit")!
      .click();
    flushSync();
    expect(mocks.quitApp).toHaveBeenCalledTimes(1);
    expect(mocks.win.close).not.toHaveBeenCalled();

    document.body.querySelector<HTMLButtonElement>("button.win-btn.close")!.click();
    flushSync();
    expect(mocks.win.close).toHaveBeenCalledTimes(1);
  });

  it("dock order puts Status left of Artifacts", () => {
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    const labels = [...document.body.querySelectorAll<HTMLButtonElement>("button.tb-btn span")].map(
      (s) => s.textContent,
    );
    expect(labels).toEqual([
      "Status",
      "Artifacts",
      "Subagents",
      "Diff",
      "Browser",
      "Terminal",
      "Files",
    ]);
  });
});
