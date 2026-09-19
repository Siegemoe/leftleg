import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({ request: vi.fn(), confirm: vi.fn() }));

// Same scaffold as SettingsWorkspace.test.ts: the modal shell mounts the real
// workspace, with the management channel and the api layer mocked out.
vi.mock("../lib/settings/mgmt", () => ({
  companionAvailable: () => true,
  bindManagement: () => mocks.request,
  setManagementScope: () => {},
  clearManagementScope: () => {},
  handleMgmtNotify: () => false,
  abortPendingMgmt: () => {},
  primeAgentDir: () => {},
  agentDirStore: {
    subscribe: (fn: (v: string | null) => void) => {
      fn(null);
      return () => {};
    },
  },
  isCompanionCommand: () => false,
}));
vi.mock("../lib/api", () => ({
  piRequest: vi.fn().mockResolvedValue({ success: true, data: {} }),
  listSessions: vi.fn().mockResolvedValue([]),
  getAgentDir: vi.fn().mockResolvedValue("/agent"),
  writeAgentExtension: vi.fn().mockResolvedValue(undefined),
  writeGuiState: vi.fn(),
}));

import SettingsModal from "./SettingsModal.svelte";
import {
  extDialog,
  keybindings,
  lastProcByProject,
  projectDir,
  settingsOpen,
  settingsProject,
} from "../lib/stores";

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const esc = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  settingsOpen.set(true);
  settingsProject.set(null);
  extDialog.set(null);
  keybindings.set({});
  mocks.request.mockReset().mockResolvedValue({ exists: false, data: null, revision: null });
  mocks.confirm.mockReset();
  vi.stubGlobal("confirm", mocks.confirm);
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
  settingsOpen.set(false);
  settingsProject.set(null);
  extDialog.set(null);
  projectDir.set("");
  lastProcByProject.set({});
  vi.unstubAllGlobals();
});

/** The behavior section is the default view; any field edit dirties the draft
 * and the workspace pushes the flag to the modal shell via onDirtyChange. */
function makeDirty(): void {
  const input = host.querySelector("#ab-prov") as HTMLInputElement;
  input.value = "openrouter";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SettingsModal escape + close protection (B3)", () => {
  it("Escape closes the modal while the draft is clean — no confirmation", async () => {
    instance = mount(SettingsModal, { target: host });
    await settle();
    esc();
    await settle();
    expect(get(settingsOpen)).toBe(false);
    expect(get(settingsProject)).toBe(null);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("Escape confirms before discarding a dirty draft, with switchScope's wording", async () => {
    instance = mount(SettingsModal, { target: host });
    await settle();
    makeDirty();
    await settle(); // workspace pushes dirty=true through onDirtyChange
    mocks.confirm.mockReturnValue(false); // user cancels — modal stays open
    esc();
    await settle();
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledWith("Discard unsaved edits for the current scope?");
    mocks.confirm.mockReturnValue(true); // user accepts the discard
    esc();
    await settle();
    expect(get(settingsOpen)).toBe(false);
    expect(get(settingsProject)).toBe(null);
  });

  it("the ✕ button and the overlay click go through the same confirmation", async () => {
    instance = mount(SettingsModal, { target: host });
    await settle();
    makeDirty();
    await settle();
    mocks.confirm.mockReturnValue(false);
    const x = [...host.querySelectorAll("button")].find((b) => b.textContent === "✕");
    x!.click();
    await settle();
    expect(get(settingsOpen)).toBe(true);
    const overlay = host.querySelector(".overlay") as HTMLElement;
    overlay.click();
    await settle();
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
  });

  it("stands down while an ExtDialog question is pending (z-200 outranks the modal)", async () => {
    extDialog.set({ id: "d1", method: "confirm", title: "Question", message: "pick one" });
    instance = mount(SettingsModal, { target: host });
    await settle();
    esc();
    await settle();
    expect(get(settingsOpen)).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});

describe("SettingsModal remount key scoping", () => {
  it("a foreground process death/restart does not re-key (discard) a scoped draft", async () => {
    settingsProject.set("/scoped");
    instance = mount(SettingsModal, { target: host });
    await settle();
    makeDirty();
    await settle();
    mocks.confirm.mockReturnValue(false);
    // Unrelated foreground churn: project switch + a fresh proc generation.
    projectDir.set("/foreground");
    lastProcByProject.update((m) => ({ ...m, "/foreground": 3 }));
    await settle();
    esc();
    await settle();
    // The scoped draft survived the churn: closing still confirms, modal stays.
    expect(mocks.confirm).toHaveBeenCalledWith("Discard unsaved edits for the current scope?");
    expect(get(settingsOpen)).toBe(true);
  });

  it("an unscoped workspace still re-keys on a foreground process change (fresh draft)", async () => {
    projectDir.set("/foreground");
    instance = mount(SettingsModal, { target: host });
    await settle();
    makeDirty();
    await settle();
    lastProcByProject.update((m) => ({ ...m, "/foreground": 3 }));
    await settle();
    esc(); // the remounted workspace is clean — closes without confirmation
    await settle();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(get(settingsOpen)).toBe(false);
    expect(get(settingsProject)).toBe(null);
  });
});
