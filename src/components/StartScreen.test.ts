import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({
  switchToProject: vi.fn(),
  sendPrompt: vi.fn(),
  lastSessionFor: vi.fn(),
  requestComposerText: vi.fn(),
  chooseProject: vi.fn(),
}));

vi.mock("svelte/transition", () => ({ fade: () => ({ duration: 0 }) }));

vi.mock("../lib/stores", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stores")>();
  return { ...actual, ...mocks };
});

import StartScreen from "./StartScreen.svelte";
import { collectUpdateInstallBlockers, projectDir, projectMeta, sessions } from "../lib/stores";
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
  composerDraftFor("startup project").set({ text: "", sending: false, lastExtensionNonce: 0, attachments: [] });
  mocks.switchToProject.mockReset().mockResolvedValue(true);
  mocks.sendPrompt.mockReset().mockResolvedValue({ ok: true });
  mocks.lastSessionFor.mockReset().mockReturnValue(undefined);
  mocks.requestComposerText.mockReset();
  mocks.chooseProject.mockReset().mockResolvedValue("/new-project");
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

describe("startup project prompt", () => {
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
    expect(mocks.requestComposerText).toHaveBeenCalledWith("retry me");
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
});
