import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  confirm: vi.fn(),
  win: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
  api: {
    piRequest: vi.fn().mockResolvedValue({ success: true, data: {} }),
    piSend: vi.fn().mockResolvedValue(undefined),
    piStart: vi.fn(),
    piStop: vi.fn(),
    piStatus: vi.fn().mockResolvedValue(false),
    listSessions: vi.fn().mockResolvedValue([]),
    readGuiState: vi.fn().mockResolvedValue({}),
    writeGuiState: vi.fn(),
    pendingGuiWriteCount: vi.fn(() => 0),
    prepareForUpdate: vi.fn(),
    cancelUpdateShutdown: vi.fn(),
    quitApp: vi.fn(),
    pickAttachments: vi.fn(),
    openPathLocal: vi.fn().mockResolvedValue(undefined),
    listArtifacts: vi.fn(),
    deleteArtifact: vi.fn(),
    gitRepoInfo: vi.fn(),
    piModuleInfo: vi.fn(),
    runPiManager: vi.fn(),
    piIntegrityReport: vi.fn(),
    getAgentDir: vi.fn().mockResolvedValue("/agent"),
    writeAgentExtension: vi.fn().mockResolvedValue(undefined),
    gitDiffSummary: vi.fn(),
    repoFiles: vi.fn(),
    fileStats: vi.fn(),
    readTextFile: vi
      .fn()
      .mockResolvedValue({ path: "src/a.ts", content: "a\n", loc: 1, size: 2, truncated: false }),
    createProjectDir: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.win }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn().mockResolvedValue("/app") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/api", () => mocks.api);
vi.mock("../lib/settings/mgmt", () => ({
  companionAvailable: () => true,
  bindManagement: () => mocks.request,
  setManagementScope: () => {},
  clearManagementScope: () => {},
  handleMgmtNotify: () => false,
  abortPendingMgmt: () => {},
  pendingManagementCount: () => 0,
  primeAgentDir: () => {},
  agentDirStore: {
    subscribe: (fn: (v: string | null) => void) => {
      fn(null);
      return () => {};
    },
  },
  isCompanionCommand: () => false,
}));

// Esc-ladder harness: mounts the always-on surfaces in App.svelte's order
// (TitleBar, FileCard, NewProjectCard, ProjectSettingsCard) plus the
// on-demand modals when a test needs them, so <svelte:window> keydown
// listeners register exactly like the real app. Esc is dispatched
// cancelable — the ladder's preventDefault stand-downs are only observable
// on a cancelable event.
import TitleBar from "./TitleBar.svelte";
import FileCard from "./FileCard.svelte";
import NewProjectCard from "./NewProjectCard.svelte";
import ProjectSettingsCard from "./ProjectSettingsCard.svelte";
import SettingsModal from "./SettingsModal.svelte";
import ExtDialog from "./ExtDialog.svelte";
import {
  aboutOpen,
  extDialog,
  fileCardFile,
  fileCardOpen,
  newProjectOpen,
  projectSettingsDir,
  settingsOpen,
} from "../lib/stores";

let host: HTMLDivElement;
const mounted: ReturnType<typeof mount>[] = [];
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const esc = () => {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  flushSync();
  return ev;
};

function bootAlways(): void {
  mounted.push(mount(TitleBar, { target: host }));
  mounted.push(mount(FileCard, { target: host }));
  mounted.push(mount(NewProjectCard, { target: host }));
  mounted.push(mount(ProjectSettingsCard, { target: host }));
  flushSync();
}

function openModal(): void {
  mounted.push(mount(SettingsModal, { target: host }));
  flushSync();
}

let extDialogInstance: ReturnType<typeof mount> | null = null;

function openExtDialog(id: string): void {
  extDialog.set({ id, method: "confirm", title: "Question", message: "pick one" });
  extDialogInstance = mount(ExtDialog, { target: host });
  mounted.push(extDialogInstance);
  flushSync();
}

/** The real app unmounts the dialog the moment extDialog clears ({#if
 * $extDialog}); the harness must drop it too — a stale dialog listener left
 * mounted would preventDefault every later Esc and break the ladder. */
async function settleDialogClosed(): Promise<void> {
  const instance = extDialogInstance;
  extDialogInstance = null;
  if (instance) {
    const at = mounted.indexOf(instance);
    if (at !== -1) mounted.splice(at, 1);
    await unmount(instance);
  }
  await settle();
}

function openFileCard(): void {
  fileCardOpen.set(true);
  fileCardFile.set({ projectDir: "/p", path: "src/a.ts" });
  flushSync();
}

/** Edit one field so the workspace pushes dirty=true to the modal shell. */
function makeDirty(): void {
  const input = host.querySelector("#ab-prov") as HTMLInputElement;
  input.value = "openrouter";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  aboutOpen.set(false);
  fileCardOpen.set(false);
  fileCardFile.set(null);
  newProjectOpen.set(false);
  projectSettingsDir.set(null);
  settingsOpen.set(false);
  extDialog.set(null);
  mocks.request.mockReset().mockResolvedValue({ exists: false, data: null, revision: null });
  mocks.confirm.mockReset().mockReturnValue(true);
  vi.stubGlobal("confirm", mocks.confirm);
  vi.stubGlobal("__APP_VERSION__", "0.0.0-test");
});

afterEach(async () => {
  for (const instance of mounted.reverse()) await unmount(instance);
  mounted.length = 0;
  document.body.replaceChildren();
  aboutOpen.set(false);
  fileCardOpen.set(false);
  fileCardFile.set(null);
  newProjectOpen.set(false);
  projectSettingsDir.set(null);
  settingsOpen.set(false);
  extDialog.set(null);
  vi.unstubAllGlobals();
});

describe("Esc ladder — exactly one layer closes per keypress", () => {
  it("About (z-150) over FileCard (z-90): only About closes", () => {
    bootAlways();
    openFileCard();
    aboutOpen.set(true);
    flushSync();

    const ev = esc();
    expect(ev.defaultPrevented).toBe(true);
    expect(get(aboutOpen)).toBe(false);
    expect(get(fileCardOpen)).toBe(true);
  });

  it("NewProjectCard (z-150) over a dirty Settings modal (z-100): only the card closes, no confirm", async () => {
    bootAlways();
    settingsOpen.set(true);
    openModal();
    await settle();
    makeDirty();
    await settle(); // workspace pushes dirty=true through onDirtyChange
    newProjectOpen.set(true);
    flushSync();

    const ev = esc();
    expect(ev.defaultPrevented).toBe(true);
    expect(get(newProjectOpen)).toBe(false);
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("ExtDialog (z-200) over About: only the dialog closes", async () => {
    bootAlways();
    aboutOpen.set(true);
    flushSync();
    openExtDialog("d1");
    await settle();

    esc();
    await settleDialogClosed();
    expect(get(extDialog)).toBe(null);
    expect(get(aboutOpen)).toBe(true);
  });

  it("ExtDialog (z-200) over a dirty Settings modal: only the dialog closes", async () => {
    bootAlways();
    settingsOpen.set(true);
    openModal();
    await settle();
    makeDirty();
    await settle();
    openExtDialog("d2");
    await settle();

    esc();
    await settleDialogClosed();
    expect(get(extDialog)).toBe(null);
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("NewProjectCard + ProjectSettingsCard co-open (same z): only the later-mounted settings card closes", () => {
    bootAlways();
    newProjectOpen.set(true);
    projectSettingsDir.set("/other");
    flushSync();

    const ev = esc();
    expect(ev.defaultPrevented).toBe(true);
    expect(get(projectSettingsDir)).toBe(null);
    expect(get(newProjectOpen)).toBe(true);
  });

  it("ProjectSettingsCard (z-150) over the Settings modal (z-100): only the card closes", async () => {
    bootAlways();
    settingsOpen.set(true);
    openModal();
    await settle();
    projectSettingsDir.set("/other");
    flushSync();

    esc();
    expect(get(projectSettingsDir)).toBe(null);
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("About (z-150) over the Settings modal (z-100): only About closes", async () => {
    bootAlways();
    settingsOpen.set(true);
    openModal();
    await settle();
    aboutOpen.set(true);
    flushSync();

    const ev = esc();
    expect(ev.defaultPrevented).toBe(true);
    expect(get(aboutOpen)).toBe(false);
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("open File menu over FileCard: the menu closes and the card stands down", () => {
    bootAlways();
    openFileCard();
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "File")!
      .click();
    flushSync();
    expect(host.querySelector(".dropdown")).not.toBeNull();

    const ev = esc();
    expect(ev.defaultPrevented).toBe(true);
    expect(host.querySelector(".dropdown")).toBeNull();
    expect(get(fileCardOpen)).toBe(true);
  });

  it("About + NewProjectCard co-open (same z): the card closes, About stands down", () => {
    bootAlways();
    aboutOpen.set(true);
    newProjectOpen.set(true);
    flushSync();

    esc();
    expect(get(newProjectOpen)).toBe(false);
    expect(get(aboutOpen)).toBe(true);
  });
});
