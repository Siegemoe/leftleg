import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

// Same scaffold as SettingsForms.test.ts: the workspace is mounted for real,
// with the management channel and the api layer mocked out.
vi.mock("../../lib/settings/mgmt", () => ({
  companionAvailable: () => true,
  bindManagement: () => mocks.request,
  setManagementScope: () => {},
  clearManagementScope: () => {},
  handleMgmtNotify: () => false,
  abortPendingMgmt: () => {},
  primeAgentDir: () => {},
  agentDirStore: { subscribe: (fn: (v: string | null) => void) => { fn(null); return () => {}; } },
  isCompanionCommand: () => false,
}));
vi.mock("../../lib/api", () => ({
  piRequest: vi.fn().mockResolvedValue({ success: true, data: {} }),
  listSessions: vi.fn().mockResolvedValue([]),
  getAgentDir: vi.fn().mockResolvedValue("/agent"),
  writeAgentExtension: vi.fn().mockResolvedValue(undefined),
  writeGuiState: vi.fn(),
}));

import SettingsWorkspace from "./SettingsWorkspace.svelte";
import { keybindings, projectDir } from "../../lib/stores";

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  keybindings.set({});
  projectDir.set("");
  mocks.request.mockReset().mockResolvedValue({ exists: false, data: null, revision: null });
});

afterEach(async () => {
  if (instance) await unmount(instance); // onDestroy removes the capture listener
  instance = null;
  document.body.replaceChildren();
  projectDir.set("");
});

function button(root: Element, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!b) throw new Error(`button missing: ${text}`);
  return b;
}

async function openKeybindingsRow(label: string): Promise<HTMLDivElement> {
  instance = mount(SettingsWorkspace, { target: host });
  await settle();
  button(host, "Key bindings").click();
  await settle();
  const row = [...host.querySelectorAll(".kb-row")].find((r) => r.textContent?.includes(label));
  if (!row) throw new Error(`key binding row missing: ${label}`);
  return row as HTMLDivElement;
}

describe("key binding capture wiring", () => {
  // Regression pin: the section-change effect used to track captureAction
  // (stopCapture reads it), so startCapture's own write re-ran the effect and
  // instantly disarmed the capture — the row could never enter capture mode.
  it("stays armed when capture starts, instead of being disarmed by the section effect", async () => {
    const row = await openKeybindingsRow("Open Artifacts dock");
    button(row, "Change").click();
    flushSync();
    expect(row.textContent).toContain("Press a key combination");
    await settle(); // any delayed effect flush must not disarm it either
    expect(row.textContent).toContain("Press a key combination");
  });

  it("applies a captured chord to the row and ends the capture", async () => {
    const row = await openKeybindingsRow("Open Artifacts dock");
    button(row, "Change").click();
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }));
    await settle();
    expect(get(keybindings)["openArtifacts"]).toBe("Ctrl+Y");
    expect(row.textContent).toContain("Ctrl+Y");
    expect(row.textContent).not.toContain("Press a key combination");
  });
});

describe("runtime section gating (B2)", () => {
  // At the start view every runtime action would throw "No project is open"
  // with its refusal note rendered invisibly behind the Settings overlay —
  // the controls must be dead with a visible reason instead.
  it("disables project-scoped runtime controls at the start view and says why", async () => {
    projectDir.set("");
    instance = mount(SettingsWorkspace, { target: host });
    await settle();
    button(host, "Current runtime").click();
    await settle();
    const model = host.querySelector("#rt-model") as HTMLSelectElement;
    expect(model.disabled).toBe(true);
    expect(model.title).toContain("Open a project");
    const compactNow = button(host, "Compact now");
    expect(compactNow.disabled).toBe(true);
    expect(compactNow.title).toContain("Open a project");
    expect(button(host, "Abort running retry").disabled).toBe(true);
    expect(button(host, "Export as HTML").disabled).toBe(true);
    expect(button(host, "Clone").disabled).toBe(true);
    // Opening a project is not project-scoped — the picker stays usable at home.
    expect(button(host, "Change…").disabled).toBe(false);
  });

  it("re-enables runtime controls once a project is open", async () => {
    projectDir.set("");
    instance = mount(SettingsWorkspace, { target: host });
    await settle();
    button(host, "Current runtime").click();
    await settle();
    expect((host.querySelector("#rt-model") as HTMLSelectElement).disabled).toBe(true);
    projectDir.set("/proj");
    await settle();
    expect((host.querySelector("#rt-model") as HTMLSelectElement).disabled).toBe(false);
  });
});
