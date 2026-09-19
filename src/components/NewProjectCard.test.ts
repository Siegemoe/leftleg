import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({ createProject: vi.fn() }));

// The card's contract: submit hands the name to createProject, a cancelled
// dialog (null) keeps the card open without an error, and a rejection shows
// inline. The store action itself (navigate gate, card close, real switch)
// is covered in stores.test.ts.
vi.mock("../lib/stores", async () => {
  const { writable } = await import("svelte/store");
  return {
    newProjectOpen: writable(false),
    extDialog: writable(null),
    projectSettingsDir: writable(null),
    createProject: mocks.createProject,
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import NewProjectCard from "./NewProjectCard.svelte";
import { newProjectOpen } from "../lib/stores";

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  newProjectOpen.set(true);
  mocks.createProject.mockReset();
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
  newProjectOpen.set(false);
});

function mountCard(): void {
  instance = mount(NewProjectCard, { target: host });
  flushSync();
}

function createButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Create project",
  )!;
  return button;
}

function typeName(value: string): void {
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

async function clickCreate(): Promise<void> {
  createButton().click();
  await settle();
}

it("keeps Create disabled for an invalid name", () => {
  mountCard();
  typeName("bad/name");
  expect(createButton().disabled).toBe(true);
  expect(mocks.createProject).not.toHaveBeenCalled();
});

it("hands the folder name to createProject and clears the field on success", async () => {
  mocks.createProject.mockResolvedValue("/work/new-project");
  mountCard();
  typeName("new-project");
  await clickCreate();
  expect(mocks.createProject).toHaveBeenCalledWith("new-project");
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
});

it("stays open without an error when the folder dialog is cancelled", async () => {
  mocks.createProject.mockResolvedValue(null);
  mountCard();
  typeName("new-project");
  await clickCreate();
  expect(get(newProjectOpen)).toBe(true);
  expect(host.querySelector(".error")).toBeNull();
  // The name survives the cancel so the user can retry.
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("new-project");
});

it("shows a failed creation as an inline error", async () => {
  mocks.createProject.mockRejectedValue(new Error("couldn't create folder: denied"));
  mountCard();
  typeName("new-project");
  await clickCreate();
  expect(get(newProjectOpen)).toBe(true);
  expect(host.querySelector(".error")?.textContent).toContain("couldn't create folder");
});
