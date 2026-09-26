import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import StatusBar from "./StatusBar.svelte";
import { extStatuses, queue, rpcState, stats, statusNote } from "../lib/stores";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  rpcState.set(null);
  statusNote.set("");
  extStatuses.set({});
  queue.set({ steering: [], followUp: [] } as never);
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

function setState() {
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
  stats.set({ contextUsage: { percent: 42 }, tokens: { total: 1500 }, cost: 0.02 } as never);
  extStatuses.set({ quality: JSON.stringify({ prettier: "ok" }) });
}

describe("status bar footer", () => {
  it("keeps run telemetry: context, tokens, extension, and queue pills", () => {
    setState();
    queue.set({ steering: [1], followUp: [] } as never);
    instance = mount(StatusBar, { target: document.body });
    flushSync();

    expect(document.body.querySelector("footer")?.textContent).toContain("Context: 42.00%");
    expect(document.body.querySelector("footer")?.textContent).toContain("1.5k tok");
    expect(document.body.querySelector("footer")?.textContent).toContain("$0.02");
    expect(document.body.querySelector(".ext-status")?.textContent).toContain("prettier");
    expect(document.body.querySelector(".queued")?.textContent).toBe("queued: 1");
  });

  it("no longer renders the branch chip, model menu, or think pill", () => {
    // They moved to the composer bar (ComposerBar.svelte).
    setState();
    instance = mount(StatusBar, { target: document.body });
    flushSync();

    expect(document.body.querySelector("footer")).not.toBeNull();
    expect(document.body.querySelector(".git-wrap")).toBeNull();
    expect(document.body.querySelector(".git-branch")).toBeNull();
    expect(document.body.querySelector(".modelwrap")).toBeNull();
    expect(document.body.querySelector("button.think")).toBeNull();
  });

  it("no longer renders the global idle/working streaming pill", () => {
    instance = mount(StatusBar, { target: document.body });
    flushSync();

    // The activity cue moved into the per-session rows (SessionRow's working
    // chip); the status bar must stay quiet about it.
    expect(document.body.querySelector(".streaming")).toBeNull();
  });
});
