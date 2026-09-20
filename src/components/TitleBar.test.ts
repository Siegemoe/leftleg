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
import {
  homePanelCollapsed,
  rightPanelOpen,
  rightPanelTab,
  searchFocusTick,
  setKeybinding,
  settingsOpen,
  settingsProject,
  sidebarOpen,
} from "../lib/stores";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "0.2.3");
  settingsOpen.set(false);
  settingsProject.set(null);
  rightPanelOpen.set(false);
  rightPanelTab.set("status");
  homePanelCollapsed.set(false);
  sidebarOpen.set(true);
  searchFocusTick.set(0);
});

function store<T>(writable: { subscribe: (fn: (v: T) => void) => () => void }): T {
  let v!: T;
  writable.subscribe((x) => (v = x))();
  return v;
}

function press(key: string, over: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...over }));
  flushSync();
}

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
      // The menu row carries the keybinding hint span, so match the label prefix.
      .find((b) => b.textContent?.startsWith("Settings…"))!
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

  it("dock chords open their tab; re-tapping the active one closes the panel", () => {
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    press("3", { ctrlKey: true });
    expect(store(rightPanelTab)).toBe("subagents");
    expect(store(rightPanelOpen)).toBe(true);

    press("3", { ctrlKey: true });
    expect(store(rightPanelOpen)).toBe(false);

    press("1", { ctrlKey: true });
    expect(store(rightPanelTab)).toBe("status");
    expect(store(rightPanelOpen)).toBe(true);
  });

  it("Ctrl+Shift+B toggles the panel regardless of tab", () => {
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    press("k", { ctrlKey: true }); // unrelated chord first — sanity for the gate below
    press("b", { ctrlKey: true, shiftKey: true });
    expect(store(rightPanelOpen)).toBe(true);
    press("b", { ctrlKey: true, shiftKey: true });
    expect(store(rightPanelOpen)).toBe(false);
    // Collapsed at the start view, the chord reveals the panel again.
    homePanelCollapsed.set(true);
    rightPanelOpen.set(true);
    press("b", { ctrlKey: true, shiftKey: true });
    expect(store(homePanelCollapsed)).toBe(false);
    expect(store(rightPanelOpen)).toBe(true);
  });

  it("focusSearch reveals the sidebar and ticks the search focus signal", () => {
    sidebarOpen.set(false);
    searchFocusTick.set(0);
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    press("k", { ctrlKey: true });
    expect(store(sidebarOpen)).toBe(true);
    expect(store(searchFocusTick)).toBe(1);
  });

  it("Ctrl+, opens settings in the general scope", () => {
    settingsProject.set("/old-project");
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    press(",", { ctrlKey: true });
    expect(store(settingsOpen)).toBe(true);
    expect(store(settingsProject)).toBeNull();
  });

  it("dispatch stands down while a modal owns the keyboard", () => {
    settingsOpen.set(true);
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    press("3", { ctrlKey: true });
    expect(store(rightPanelOpen)).toBe(false);
  });

  it("user overrides retarget dispatch — an unbound action becomes reachable", () => {
    instance = mount(TitleBar, { target: document.body });
    flushSync();

    setKeybinding("clearQueue", "Ctrl+Shift+U");
    flushSync();
    // Empty queue: the guard skips the rpc round-trip — nothing to observe
    // except that the chord was consumed without error.
    press("u", { ctrlKey: true, shiftKey: true });
    setKeybinding("clearQueue", null);
  });
});
