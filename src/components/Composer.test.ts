// Component test for the composer's draft-revision contract (review fix P1):
// acceptance clears only what was submitted — typing or an extension-provided
// draft pushed while awaiting the response must survive.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

vi.mock("../lib/api", () => ({
  piRequest: vi.fn(),
  piSend: vi.fn().mockResolvedValue(undefined),
  piStart: vi.fn().mockResolvedValue(undefined),
  piStop: vi.fn().mockResolvedValue(undefined),
  piStatus: vi.fn().mockResolvedValue(false),
  listSessions: vi.fn().mockResolvedValue([]),
  readGuiState: vi.fn().mockResolvedValue({}),
  writeGuiState: vi.fn().mockResolvedValue(undefined),
  readFileBase64: vi.fn().mockResolvedValue(""),
  getAgentDir: vi.fn().mockResolvedValue(""),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import * as api from "../lib/api";
import * as dialog from "@tauri-apps/plugin-dialog";
import Composer from "./Composer.svelte";
import { composerDraft, connected, projectDir, requestComposerText, streaming } from "../lib/stores";

let host: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;

function textArea(): HTMLTextAreaElement {
  const el = host.querySelector("textarea");
  if (!el) throw new Error("composer textarea not mounted");
  return el;
}

function type(value: string) {
  const el = textArea();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function clickSend() {
  const btn = host.querySelector<HTMLButtonElement>('button[title="Send"]');
  if (!btn) throw new Error("send button not found");
  btn.click();
  flushSync();
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  connected.set(true);
  projectDir.set("/proj");
  streaming.set(false);
  composerDraft.set(null);
  vi.mocked(api.piRequest).mockReset();
});

afterEach(() => {
  if (instance) {
    unmount(instance);
    instance = null;
  }
  host.remove();
});

describe("Composer draft revisions", () => {
  it("clears the draft when it was not touched while awaiting acceptance", async () => {
    vi.mocked(api.piRequest).mockResolvedValue({ success: true } as never);
    instance = mount(Composer, { target: host });
    flushSync();

    type("hello");
    clickSend();
    await settle();

    expect(textArea().value).toBe("");
    expect(vi.mocked(api.piRequest)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "prompt", message: "hello" }),
      600,
      "/proj",
      undefined,
    );
  });

  it("keeps the draft when pi rejects the prompt", async () => {
    vi.mocked(api.piRequest).mockResolvedValue({ success: false, error: "nope" } as never);
    instance = mount(Composer, { target: host });
    flushSync();

    type("hello");
    clickSend();
    await settle();

    expect(textArea().value).toBe("hello");
  });

  it("typing while awaiting acceptance survives: only the submitted part is cleared", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(api.piRequest).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    instance = mount(Composer, { target: host });
    flushSync();

    type("first prompt");
    clickSend();
    await settle(); // response still pending — the user keeps typing
    type("first promptXYZ");

    release({ success: true });
    await settle();

    expect(textArea().value).toBe("XYZ");
  });

  it("an extension draft pushed mid-flight survives acceptance untouched", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(api.piRequest).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    instance = mount(Composer, { target: host });
    flushSync();

    type("outgoing");
    clickSend();
    await settle();
    requestComposerText("extension wrote this");
    await settle();
    expect(textArea().value).toBe("extension wrote this");

    release({ success: true });
    await settle();

    expect(textArea().value).toBe("extension wrote this");
  });

  it("attachments added while awaiting acceptance survive too", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(api.piRequest).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    instance = mount(Composer, { target: host });
    flushSync();

    type("with image");
    vi.mocked(api.readFileBase64).mockResolvedValue("QUJD");
    vi.mocked(dialog.open).mockResolvedValueOnce(["/images/first.png"]);
    host.querySelector<HTMLButtonElement>('[title="Attach images or files"]')!.click();
    await settle();
    clickSend();
    await settle();
    vi.mocked(dialog.open).mockResolvedValueOnce(["/images/second.png"]);
    host.querySelector<HTMLButtonElement>('[title="Attach images or files"]')!.click();
    await settle();
    release({ success: true });
    await settle();
    expect([...host.querySelectorAll(".attachments .name")].map((n) => n.textContent)).toEqual(["second.png"]);
  });

  it("scopes drafts and remembers that an extension draft has already been edited", async () => {
    instance = mount(Composer, { target: host, props: { draftKey: "draft-a" } });
    requestComposerText("seed"); await settle();
    type("user revision");
    const old = { text: "seed", nonce: 1 };
    const { get } = await import("svelte/store");
    Object.assign(old, get(composerDraft));
    await unmount(instance);
    composerDraft.set(null);
    instance = mount(Composer, { target: host, props: { draftKey: "draft-b" } });
    flushSync(); expect(textArea().value).toBe("");
    type("other project"); await unmount(instance);
    composerDraft.set(old);
    instance = mount(Composer, { target: host, props: { draftKey: "draft-a" } });
    flushSync(); expect(textArea().value).toBe("user revision");
  });

  it("keeps an in-flight submission disabled after returning to its draft", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(api.piRequest).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    instance = mount(Composer, { target: host, props: { draftKey: "pending-draft" } });
    flushSync(); type("pending"); clickSend();
    await unmount(instance);
    instance = mount(Composer, { target: host, props: { draftKey: "pending-draft" } });
    flushSync();
    expect(host.querySelector<HTMLButtonElement>('[title="Send"]')!.disabled).toBe(true);
    release({ success: true }); await settle();
    expect(textArea().value).toBe("");
  });
});
