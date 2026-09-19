import { afterEach, expect, it, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
vi.mock("../lib/api", () => ({
  piRequest: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  openPathLocal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/path", () => ({
  resolve: vi.fn().mockResolvedValue("/work/src/file.ts"),
}));
import { openPathLocal } from "../lib/api";
import { resolve } from "@tauri-apps/api/path";
import Chat from "./Chat.svelte";
import ToolCard from "./ToolCard.svelte";
import { items, streaming, projectDir, composerDraft, disconnected } from "../lib/stores";
const instances: ReturnType<typeof mount>[] = [];
it("shows offline recovery instead of a permanent startup message after Pi exits", () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  items.set([]);
  projectDir.set("/work");
  disconnected.set(true);
  instances.push(mount(Chat, { target: document.body }));
  flushSync();
  expect(document.querySelector(".hero")?.textContent).toContain("Pi is offline");
  expect(document.querySelector(".hero")?.textContent).not.toContain("Starting pi");
  disconnected.set(false);
});
afterEach(async () => {
  for (const i of instances.splice(0)) await unmount(i);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it("scrolls on store updates and respects scrolling away from the bottom", () => {
  const raf = vi.fn().mockReturnValue(1);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  items.set([]);
  streaming.set(false);
  projectDir.set("/work");
  composerDraft.set(null);
  instances.push(mount(Chat, { target: document.body }));
  flushSync();
  const scroller = document.querySelector<HTMLDivElement>(".chat")!;
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  scroller.scrollTo = vi.fn();
  raf.mockClear();
  items.set([{ kind: "user", id: "u1", text: "new", images: [] }]);
  flushSync();
  expect(raf).toHaveBeenCalled();
  raf.mock.calls.at(-1)![0](0);
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000 });
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  flushSync();
  raf.mockClear();
  items.set([{ kind: "user", id: "u2", text: "another", images: [] }]);
  flushSync();
  expect(raf).not.toHaveBeenCalled();
});
it("resolves a tool's relative file path against the active project", async () => {
  projectDir.set("/work");
  instances.push(
    mount(ToolCard, {
      target: document.body,
      props: {
        item: {
          kind: "tool",
          id: "t1",
          toolCallId: "1",
          name: "edit",
          args: JSON.stringify({ path: "src/file.ts" }),
          status: "done",
          output: "",
          outputTruncated: false,
          isError: false,
          diff: "+line",
        },
      },
    }),
  );
  flushSync();
  document.querySelector<HTMLButtonElement>(".head")!.click();
  flushSync();
  document.querySelector<HTMLButtonElement>(".actions button")!.click();
  await vi.waitFor(() => expect(openPathLocal).toHaveBeenCalledWith("/work/src/file.ts"));
  expect(resolve).toHaveBeenCalledWith("/work", "src/file.ts");
});
it("renders malformed tool arguments without crashing the chat", () => {
  expect(() => {
    instances.push(
      mount(ToolCard, {
        target: document.body,
        props: {
          item: {
            kind: "tool",
            id: "t2",
            toolCallId: "1",
            name: "read",
            args: '{"path":42}',
            status: "error",
            output: "invalid path",
            outputTruncated: false,
            isError: true,
          },
        },
      }),
    );
    flushSync();
  }).not.toThrow();
});
