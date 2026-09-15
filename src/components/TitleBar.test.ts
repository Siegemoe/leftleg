import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";

const mocks = vi.hoisted(() => ({
  piRequest: vi.fn(),
  piModuleInfo: vi.fn().mockResolvedValue({ name: "pi", version: "1", path: "/pi" }),
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
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, piRequest: mocks.piRequest, piModuleInfo: mocks.piModuleInfo };
});
vi.mock("../lib/updater", () => ({
  checkForUpdates: mocks.checkForUpdates,
  applyUpdate: mocks.applyUpdate,
  updateAvailable: writable(null),
  updateStatus: writable("idle"),
  updateCheck: writable({ status: "idle", at: null, message: "" }),
}));

import TitleBar from "./TitleBar.svelte";
import StatusBar from "./StatusBar.svelte";
import {
  activeSessionPath, lastProcByProject, projectDir, settingsOpen, settingsProject,
} from "../lib/stores";
import { updateAvailable, updateCheck, updateStatus } from "../lib/updater";

let instance: ReturnType<typeof mount> | null = null;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function todoMessage(subject: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name: "todo", arguments: { tasks: [{ key: subject, status: "pending", subject }] } }],
  };
}

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "0.2.3");
  mocks.piRequest.mockReset();
  projectDir.set("/a");
  activeSessionPath.set("/a/session.jsonl");
  lastProcByProject.set({ "/a": 7 });
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

describe("title bar state ownership", () => {
  it("drops an older todo response after the status card is closed and reopened", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    mocks.piRequest
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    instance = mount(TitleBar, { target: document.body });
    flushSync();
    const statusButton = document.body.querySelector<HTMLButtonElement>(".statuswrap > button")!;

    statusButton.click();
    await vi.waitFor(() => expect(mocks.piRequest).toHaveBeenCalledWith(
      { type: "get_messages" }, 60, "/a", 7,
    ));
    statusButton.click();
    statusButton.click();
    await vi.waitFor(() => expect(mocks.piRequest).toHaveBeenCalledTimes(2));
    resolveNew({ success: true, data: { messages: [todoMessage("new task")] } });
    await settle();
    resolveOld({ success: true, data: { messages: [todoMessage("old task")] } });
    await settle();

    expect(document.body.textContent).toContain("new task");
    expect(document.body.textContent).not.toContain("old task");
  });

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
