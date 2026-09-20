import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import SubagentsPanel from "./SubagentsPanel.svelte";
import { items } from "../lib/stores";
import type { ToolItem, UiItem } from "../lib/types";

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  items.set([]);
});

afterEach(async () => {
  if (instance) {
    await unmount(instance);
    instance = null;
  }
  document.body.replaceChildren();
});

function toolItem(over: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    id: "i1",
    toolCallId: "tc1",
    name: "subagent",
    args: "{}",
    status: "running",
    output: "",
    outputTruncated: false,
    isError: false,
    ...over,
  };
}

function mountPanel(list: UiItem[]) {
  items.set(list);
  instance = mount(SubagentsPanel, { target: document.body });
  flushSync();
}

describe("subagents panel", () => {
  it("shows the empty state when no subagent tool calls exist", () => {
    mountPanel([]);
    expect(document.body.textContent).toContain("No subagent runs");
  });

  it("ignores ordinary tools", () => {
    mountPanel([toolItem({ name: "read", toolCallId: "r1" })]);
    expect(document.body.textContent).toContain("No subagent runs");
  });

  it("renders a live run from the heartbeat snapshot", () => {
    mountPanel([
      toolItem({
        args: JSON.stringify({ agent: "scout", task: "map the repo" }),
        details: {
          mode: "single",
          results: [{ agent: "scout", task: "map the repo", status: "running" }],
        },
      }),
    ]);
    expect(document.body.querySelector(".who")?.textContent).toBe("scout");
    expect(document.body.querySelector(".run .dot")?.className).toContain("run");
    expect(document.body.querySelector(".count")?.textContent).toContain("1 running");
    // Expanding shows the requested task text.
    document.body.querySelector<HTMLButtonElement>(".run")!.click();
    flushSync();
    expect(document.body.querySelector(".t-task")?.textContent).toBe("map the repo");
  });

  it("renders a finished multi-agent run with usage", () => {
    mountPanel([
      toolItem({
        status: "done",
        isError: false,
        startedAt: 1000,
        endedAt: 61_000,
        durationMs: 60_000,
        timestamp: 61_000,
        args: JSON.stringify({ tasks: [{ agent: "a" }, { agent: "b" }] }),
        details: {
          mode: "parallel",
          results: [
            {
              agent: "a",
              status: "success",
              model: "m1",
              usage: { input: 900, output: 100, cost: 0.004 },
            },
            {
              agent: "b",
              status: "error",
              errorMessage: "boom",
              usage: { input: 1500, output: 500, cost: 0.02 },
            },
          ],
        },
      }),
    ]);
    expect(document.body.querySelector(".who")?.textContent).toBe("2 agents");
    const meta = document.body.querySelector(".meta")?.textContent ?? "";
    expect(meta).toContain("3.0k tok");
    expect(meta).toContain("$0.02");
    expect(meta).toContain("1m");
    // One agent succeeded, one failed — the run reads as failed.
    expect(document.body.querySelector(".run .dot")?.className).toContain("err");
    document.body.querySelector<HTMLButtonElement>(".run")!.click();
    flushSync();
    const statuses = [...document.body.querySelectorAll(".t-status")].map((s) => s.textContent);
    expect(statuses).toEqual(["success", "error"]);
    expect(document.body.querySelector(".t-error")?.textContent).toBe("boom");
  });

  it("survives malformed details and unusual statuses", () => {
    mountPanel([
      toolItem({ status: "done", isError: false, details: { results: "not-an-array" } }),
    ]);
    // Falls back to the call's arguments for the row identity, degraded to
    // an unknown status — never a crash or an empty panel.
    expect(document.body.querySelector(".who")?.textContent).toBe("agent");
    expect(() => {
      document.body.querySelector<HTMLButtonElement>(".run")!.click();
      flushSync();
    }).not.toThrow();
    expect(document.body.querySelector(".t-status")?.textContent).toBe("unknown");
  });
});
