import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

const mocks = vi.hoisted(() => ({ gitRepoInfo: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, gitRepoInfo: mocks.gitRepoInfo };
});

import Sidebar from "./Sidebar.svelte";
import {
  activeSessionPath, connected, pins, projectDir, projectMeta, projectScope,
  sessionQuery, sessionStates, sessions, settled, settledView, visitedAt,
} from "../lib/stores";

let instance: ReturnType<typeof mount> | null = null;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

beforeEach(() => {
  mocks.gitRepoInfo.mockReset().mockResolvedValue({ repo: false, branch: "", dirty: 0, toplevel: "" });
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
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

describe("sidebar project ownership", () => {
  it("offers known projects before their first session file exists", () => {
    projectDir.set("/empty");
    projectMeta.set({ "/empty": { name: "Empty project" } });
    instance = mount(Sidebar, { target: document.body });
    flushSync();

    document.body.querySelector<HTMLButtonElement>(".scope-btn.wide")!.click();
    flushSync();
    expect([...document.body.querySelectorAll(".scope-item")].some((el) => el.textContent?.includes("Empty project"))).toBe(true);
  });

  it("does not show a stale branch after switching projects", async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    mocks.gitRepoInfo
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    projectDir.set("/a");
    instance = mount(Sidebar, { target: document.body });
    flushSync();
    await vi.waitFor(() => expect(mocks.gitRepoInfo).toHaveBeenCalledWith("/a"));

    projectDir.set("/b");
    flushSync();
    await vi.waitFor(() => expect(mocks.gitRepoInfo).toHaveBeenCalledWith("/b"));
    resolveB({ repo: true, branch: "branch-b", dirty: 0, toplevel: "/b" });
    await settle();
    resolveA({ repo: true, branch: "branch-a", dirty: 0, toplevel: "/a" });
    await settle();

    expect(document.body.querySelector(".git-branch")?.textContent).toBe("branch-b");
  });
});
