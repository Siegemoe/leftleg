import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import Sidebar from "./Sidebar.svelte";
import {
  activeSessionPath,
  connected,
  pins,
  projectDir,
  projectMeta,
  projectScope,
  sessionQuery,
  sessionStates,
  sessions,
  settled,
  settledView,
  visitedAt,
} from "../lib/stores";
import { updateAvailable, updateCheck, updateStatus } from "../lib/updater";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  activeSessionPath.set(null);
  connected.set(true);
  pins.set([]);
  projectDir.set("");
  projectMeta.set({});
  projectScope.set(null);
  sessionQuery.set("");
  sessionStates.set({});
  sessions.set([]);
  settled.set([]);
  settledView.set("per-project");
  visitedAt.set({});
  updateAvailable.set(null);
  updateStatus.set("idle");
  updateCheck.set({ status: "idle", at: null, message: "" });
  vi.stubGlobal("__APP_VERSION__", "0.2.3");
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("sidebar project ownership", () => {
  it("offers known projects before their first session file exists", () => {
    projectDir.set("/empty");
    projectMeta.set({ "/empty": { name: "Empty project" } });
    instance = mount(Sidebar, { target: document.body });
    flushSync();

    document.body.querySelector<HTMLButtonElement>(".scope-btn.wide")!.click();
    flushSync();
    expect(
      [...document.body.querySelectorAll(".scope-item")].some((el) =>
        el.textContent?.includes("Empty project"),
      ),
    ).toBe(true);
  });
});

describe("sidebar footer", () => {
  it("shows the updater chip + version where the branch chip used to be", () => {
    updateAvailable.set({ version: "0.3.0" } as never);
    updateStatus.set("ready");
    updateCheck.set({ status: "available", at: Date.now(), message: "v0.3.0 is available" });
    instance = mount(Sidebar, { target: document.body });
    flushSync();

    const button = document.body.querySelector<HTMLButtonElement>("button.upd")!;
    expect(button.textContent).toContain("update downloaded — install");
    expect(button.disabled).toBe(false);
    expect(document.body.querySelector(".version")?.textContent).toBe("v0.2.3");
    // The branch chip moved to the status bar.
    expect(document.body.querySelector(".git-wrap")).toBeNull();
  });
});
