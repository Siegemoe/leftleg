import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

const mocks = vi.hoisted(() => ({ gitRepoInfo: vi.fn(), gitDiffSummary: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, gitRepoInfo: mocks.gitRepoInfo, gitDiffSummary: mocks.gitDiffSummary };
});

import StatusBar from "./StatusBar.svelte";
import { projectDir, rpcState } from "../lib/stores";

let instance: ReturnType<typeof mount> | null = null;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

beforeEach(() => {
  mocks.gitRepoInfo
    .mockReset()
    .mockResolvedValue({ repo: false, branch: "", dirty: 0, toplevel: "" });
  mocks.gitDiffSummary.mockReset().mockResolvedValue({ repo: false, files: [], truncated: false });
  projectDir.set("");
  rpcState.set(null);
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

describe("status bar branch chip", () => {
  it("leads the footer and shows the active branch + dirty count", async () => {
    mocks.gitRepoInfo.mockResolvedValue({ repo: true, branch: "main", dirty: 3, toplevel: "/a" });
    projectDir.set("/a");
    instance = mount(StatusBar, { target: document.body });
    flushSync();
    await vi.waitFor(() =>
      expect(document.body.querySelector(".git-branch")?.textContent).toBe("main"),
    );
    expect(document.body.querySelector(".git-dirty")?.textContent).toBe("3");
    const footer = document.body.querySelector("footer")!;
    expect(footer.firstElementChild?.classList.contains("git-wrap")).toBe(true);
  });

  it("does not show a stale branch after switching projects", async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    mocks.gitRepoInfo
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve;
          }),
      );
    projectDir.set("/a");
    instance = mount(StatusBar, { target: document.body });
    flushSync();
    await vi.waitFor(() => expect(mocks.gitRepoInfo).toHaveBeenCalledWith("/a"));

    projectDir.set("/b");
    flushSync();
    // The switch clears the old repo's chip up front — nothing stale lingers
    // while the new project's info is in flight.
    expect(document.body.querySelector(".git-branch")).toBeNull();
    await vi.waitFor(() => expect(mocks.gitRepoInfo).toHaveBeenCalledWith("/b"));
    resolveB({ repo: true, branch: "branch-b", dirty: 0, toplevel: "/b" });
    await settle();
    resolveA({ repo: true, branch: "branch-a", dirty: 0, toplevel: "/a" });
    await settle();

    expect(document.body.querySelector(".git-branch")?.textContent).toBe("branch-b");
  });

  it("keeps the model pill in the same row, right of the branch chip", async () => {
    mocks.gitRepoInfo.mockResolvedValue({ repo: true, branch: "main", dirty: 0, toplevel: "/a" });
    projectDir.set("/a");
    rpcState.set({
      model: {
        provider: "p",
        id: "m",
        name: "Model One",
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 8192,
      },
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    });
    instance = mount(StatusBar, { target: document.body });
    flushSync();
    await vi.waitFor(() =>
      expect(document.body.querySelector(".git-branch")?.textContent).toBe("main"),
    );

    const footer = document.body.querySelector("footer")!;
    expect(footer.children[0].classList.contains("git-wrap")).toBe(true);
    expect(footer.children[1].classList.contains("modelwrap")).toBe(true);
    // The updater chip + version moved to the sidebar footer.
    expect(document.body.querySelector("footer .version")).toBeNull();
    expect(document.body.querySelector("footer button.upd")).toBeNull();
  });

  it("opens the diff popover on keyboard focus and closes on blur", async () => {
    mocks.gitRepoInfo.mockResolvedValue({ repo: true, branch: "main", dirty: 1, toplevel: "/a" });
    mocks.gitDiffSummary.mockResolvedValue({
      repo: true,
      files: [{ path: "f.ts", added: 4, deleted: 1 }],
      truncated: false,
    });
    projectDir.set("/a");
    instance = mount(StatusBar, { target: document.body });
    flushSync();
    const chip = await vi.waitFor(() => {
      const el = document.body.querySelector<HTMLButtonElement>(".git-chip");
      expect(el).not.toBeNull();
      return el!;
    });

    // Focus mirrors hover so keyboard users get the diff totals.
    chip.dispatchEvent(new FocusEvent("focus"));
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 400));
    flushSync();
    const pop = document.body.querySelector(".diff-pop");
    expect(pop?.textContent).toContain("+4");
    expect(pop?.textContent).toContain("−1");

    // Blur dismisses it, mirroring mouse-leave.
    chip.dispatchEvent(new FocusEvent("blur"));
    flushSync();
    expect(document.body.querySelector(".diff-pop")).toBeNull();
  });

  it("no longer renders the global idle/working streaming pill", () => {
    instance = mount(StatusBar, { target: document.body });
    flushSync();

    // The activity cue moved into the per-session rows (SessionRow's working
    // chip); the status bar must stay quiet about it.
    expect(document.body.querySelector(".streaming")).toBeNull();
  });
});
