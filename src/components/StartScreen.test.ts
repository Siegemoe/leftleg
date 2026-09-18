import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({
  switchToProject: vi.fn(),
  sendPrompt: vi.fn(),
  lastSessionFor: vi.fn(),
  requestComposerText: vi.fn(),
  chooseProject: vi.fn(),
  pickAttachments: vi.fn(),
}));

vi.mock("svelte/transition", () => ({ fade: () => ({ duration: 0 }) }));

vi.mock("../lib/stores", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stores")>();
  return { ...actual, ...mocks };
});

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, pickAttachments: mocks.pickAttachments };
});

import StartScreen from "./StartScreen.svelte";
import { activeSessionPath, collectUpdateInstallBlockers, projectDir, projectMeta, sessions, statusNote, updateInstallLock } from "../lib/stores";
import { composerDraftFor } from "../lib/composer-drafts";

let instance: ReturnType<typeof mount> | null = null;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function typeDraft(value: string) {
  const input = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

beforeEach(() => {
  projectDir.set("");
  projectMeta.set({ "/proj": { name: "Project" } });
  sessions.set([]);
  activeSessionPath.set("/session-a");
  statusNote.set("");
  updateInstallLock.set(false);
  composerDraftFor("/proj:/session-a").set({ text: "", sending: false, lastExtensionNonce: 0, attachments: [] });
  composerDraftFor("startup project").set({ text: "", sending: false, lastExtensionNonce: 0, attachments: [] });
  mocks.switchToProject.mockReset().mockImplementation(async (dir: string) => { projectDir.set(dir); return true; });
  mocks.sendPrompt.mockReset().mockResolvedValue({ ok: true });
  mocks.lastSessionFor.mockReset().mockReturnValue(undefined);
  mocks.requestComposerText.mockReset();
  mocks.pickAttachments.mockReset();
  mocks.chooseProject.mockReset().mockImplementation(async () => { projectDir.set("/new-project"); return "/new-project"; });
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

describe("startup project prompt", () => {
  it("uses the session loaded after the startup screen unmounts", async () => {
    let finishOpen!: (value: boolean) => void;
    mocks.switchToProject.mockImplementation(() => {
      projectDir.set("/proj");
      return new Promise((resolve) => { finishOpen = resolve; });
    });
    mocks.sendPrompt.mockResolvedValue({ ok: false });
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("recover after startup");
    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();
    await unmount(instance);
    instance = null;
    activeSessionPath.set("/late-session");
    finishOpen(true);
    await settle();
    expect(get(composerDraftFor("/proj:/late-session")).text).toBe("recover after startup");
  });

  it("shows the reason a project could not open on the startup screen", async () => {
    mocks.switchToProject.mockImplementation(async () => { statusNote.set("Couldn't open project: permission denied"); return false; });
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();
    expect(document.body.textContent).toContain("Couldn't open project: permission denied");
  });

  it("keeps edits made while the initial prompt is pending", async () => {
    let finish!: (value: { ok: boolean }) => void;
    mocks.sendPrompt.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("first");
    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();
    typeDraft("first and more");
    finish({ ok: true });
    await settle();
    expect(get(composerDraftFor("startup project")).text).toBe(" and more");
  });

  it("restores a rejected prompt to its original project after navigation", async () => {
    let finish!: (value: { ok: boolean }) => void;
    mocks.sendPrompt.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("for project A");
    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();
    projectDir.set("/project-b");
    activeSessionPath.set("/session-b");
    finish({ ok: false });
    await settle();
    expect(get(composerDraftFor("/proj:/session-a")).text).toBe("for project A");
    expect(mocks.requestComposerText).not.toHaveBeenCalled();
  });

  it("keeps the draft and does not send when the project cannot open", async () => {
    mocks.switchToProject.mockResolvedValue(false);
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("keep this");
    expect(collectUpdateInstallBlockers()).toContain("startup project has unsent text");

    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();

    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("keep this");
  });

  it("moves a rejected first prompt into the project composer", async () => {
    mocks.sendPrompt.mockResolvedValue({ ok: false, error: "rejected" });
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("retry me");

    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();

    expect(mocks.sendPrompt).toHaveBeenCalledWith("retry me", []);
    expect(get(composerDraftFor("/proj:/session-a")).text).toBe("retry me");
    expect(get(composerDraftFor("startup project")).text).toBe("");
    expect(collectUpdateInstallBlockers()).not.toContain("startup project has unsent text");
  });

  it("clears the startup draft only after Pi accepts it", async () => {
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("send me");

    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();

    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(mocks.requestComposerText).not.toHaveBeenCalled();
  });

  it("sends the typed first prompt after choosing a new folder", async () => {
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("start the project");

    document.body.querySelector<HTMLButtonElement>(".ghostcard")!.click();
    await settle();

    expect(mocks.chooseProject).toHaveBeenCalledOnce();
    expect(mocks.sendPrompt).toHaveBeenCalledWith("start the project", []);
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
  });

  it("sends text and attachments through the folder-picker flow via the send button", async () => {
    mocks.pickAttachments.mockResolvedValue([{ name: "shot.png", path: "C:/t/shot.png", data: "aGVsbG8=" }]);
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("look at this");

    document.body.querySelector<HTMLButtonElement>(".add")!.click();
    await settle();
    document.body.querySelector<HTMLButtonElement>(".send")!.click();
    await settle();

    expect(mocks.chooseProject).toHaveBeenCalledOnce();
    expect(mocks.sendPrompt).toHaveBeenCalledWith("look at this", [
      { data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" },
    ]);
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(document.body.querySelectorAll(".chip").length).toBe(0);
  });

  it("renders attachment chips with thumbnails and removes them", async () => {
    mocks.pickAttachments.mockResolvedValue([
      { name: "notes.txt", path: "C:/t/notes.txt", data: "aGk=" },
      { name: "shot.png", path: "C:/t/shot.png", data: "aGVsbG8=" },
    ]);
    instance = mount(StartScreen, { target: document.body });
    flushSync();

    document.body.querySelector<HTMLButtonElement>(".add")!.click();
    await settle();

    expect(document.body.querySelectorAll(".chip").length).toBe(2);
    expect(document.body.querySelector(".chip img")).not.toBeNull();
    expect(document.body.querySelector(".chip img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");

    document.body.querySelector<HTMLButtonElement>(".chip .rm")!.click();
    flushSync();

    expect(document.body.querySelectorAll(".chip").length).toBe(1);
    expect(document.body.textContent).toContain("shot.png");
    expect(document.body.textContent).not.toContain("notes.txt");
  });

  it("rejects an oversized pasted image with a note", async () => {
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    const big = new File([new ArrayBuffer(21 * 1024 * 1024)], "big.png", { type: "image/png" });
    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => big }] },
    });

    textarea.dispatchEvent(paste);
    await settle();

    expect(get(statusNote)).toBe("Pasted image exceeds 20 MiB limit");
    expect(document.body.querySelectorAll(".chip").length).toBe(0);
  });

  it("moves attachments of a rejected first prompt into the project composer", async () => {
    mocks.pickAttachments.mockResolvedValue([{ name: "shot.png", path: "C:/t/shot.png", data: "aGVsbG8=" }]);
    mocks.sendPrompt.mockResolvedValue({ ok: false, error: "rejected" });
    instance = mount(StartScreen, { target: document.body });
    flushSync();
    typeDraft("retry with this");

    document.body.querySelector<HTMLButtonElement>(".add")!.click();
    await settle();
    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();

    expect(mocks.sendPrompt).toHaveBeenCalledWith("retry with this", [
      { data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" },
    ]);
    const destination = get(composerDraftFor("/proj:/session-a"));
    expect(destination.text).toBe("retry with this");
    expect(destination.attachments).toEqual([
      { name: "shot.png", mimeType: "image/png", data: "aGVsbG8=", isImage: true },
    ]);
    expect(get(composerDraftFor("startup project")).text).toBe("");
    expect(document.body.querySelectorAll(".chip").length).toBe(0);
  });

  it("keeps staged attachments across remount and counts them as update blockers", async () => {
    mocks.pickAttachments.mockResolvedValue([{ name: "shot.png", path: "C:/t/shot.png", data: "aGVsbG8=" }]);
    instance = mount(StartScreen, { target: document.body });
    flushSync();

    document.body.querySelector<HTMLButtonElement>(".add")!.click();
    await settle();
    expect(document.body.querySelectorAll(".chip").length).toBe(1);

    // goHome → back: the chip survives because it lives in the startup draft
    // store, not in the unmounted component.
    await unmount(instance);
    instance = null;
    expect(collectUpdateInstallBlockers()).toContain("startup project has 1 attachment");

    instance = mount(StartScreen, { target: document.body });
    flushSync();
    expect(document.body.querySelectorAll(".chip").length).toBe(1);
    expect(document.body.querySelector(".chip img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("ignores paste and chip removal while a project is opening", async () => {
    mocks.pickAttachments.mockResolvedValue([{ name: "kept.png", path: "C:/t/kept.png", data: "a2VwdA==" }]);
    let releaseOpen!: (value: boolean) => void;
    mocks.switchToProject.mockImplementation(() => {
      projectDir.set("/proj");
      return new Promise((resolve) => { releaseOpen = resolve; });
    });
    instance = mount(StartScreen, { target: document.body });
    flushSync();

    document.body.querySelector<HTMLButtonElement>(".add")!.click();
    await settle();
    typeDraft("hold this");
    document.body.querySelector<HTMLButtonElement>(".card:not(.ghostcard)")!.click();
    await settle();

    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(true);

    // A paste during the open window must not stage anything: it would miss
    // `sent` and silently drop on unmount.
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["late"], "late.png", { type: "image/png" }) }] },
    });
    textarea.dispatchEvent(paste);
    await settle();
    await settle(); // a second round: an ungated paste would finish its FileReader read here

    const rm = document.body.querySelector<HTMLButtonElement>(".chip .rm")!;
    expect(rm.disabled).toBe(true);
    rm.click();
    flushSync();

    releaseOpen(true);
    await settle();

    // Exactly the pre-flight chip was delivered — no late paste, no removal
    // desync, nothing resurrected or duplicated after settle.
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.sendPrompt).toHaveBeenCalledWith("hold this", [
      { data: "a2VwdA==", mimeType: "image/png", name: "kept.png" },
    ]);
    expect(document.body.querySelectorAll(".chip").length).toBe(0);
    expect(get(composerDraftFor("startup project")).attachments).toEqual([]);
    expect(get(composerDraftFor("/proj:/session-a")).attachments).toEqual([]);
    expect(textarea.disabled).toBe(false);
  });

  it("stands down the paperclip during the update install lock", async () => {
    updateInstallLock.set(true);
    mocks.pickAttachments.mockResolvedValue([{ name: "late.png", path: "C:/t/late.png", data: "bGF0ZQ==" }]);
    instance = mount(StartScreen, { target: document.body });
    flushSync();

    const add = document.body.querySelector<HTMLButtonElement>(".add")!;
    expect(add.disabled).toBe(true);
    add.click();
    await settle();

    expect(mocks.pickAttachments).not.toHaveBeenCalled();
    expect(document.body.querySelectorAll(".chip").length).toBe(0);
  });
});
