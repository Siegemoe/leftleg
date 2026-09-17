import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../lib/settings/mgmt", () => ({ companionAvailable: () => true, bindManagement: () => mocks.request, handleMgmtNotify: () => false, abortPendingMgmt: () => {}, companionAgentDir: () => undefined, isCompanionCommand: () => false }));
vi.mock("../../lib/api", () => ({ piRequest: vi.fn().mockResolvedValue({ success: true, data: {} }), listSessions: vi.fn().mockResolvedValue([]), getAgentDir: vi.fn().mockResolvedValue("/agent"), writeGuiState: vi.fn() }));
import PackageForms from "./PackageForms.svelte";
import SettingsWorkspace from "./SettingsWorkspace.svelte";
import { applyMerge, applyNamespaces } from "../../../companion/leftleg-settings/index";
import { settingsOpen, settingsProject, projectDir, activeSessionPath, rpcState } from "../../lib/stores";
import * as api from "../../lib/api";
let host: HTMLDivElement;
let instance: ReturnType<typeof mount>;
let doc: Record<string, any>;
let revision: number;
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host);
  projectDir.set("/project"); activeSessionPath.set("/session");
  rpcState.set({ sessionFile: "/session", sessionName: "old" } as never);
  settingsOpen.set(true); settingsProject.set(null);
  doc = { defaultProvider: "old", subagent: { roles: { coder: { models: ["p/m:free"] }, reviewer: { models: ["p/r"] } }, agentModels: { scout: "p/s" } }, permission: { bash: { "old*": "deny", "keep*": "allow" } }, theme: "dark" };
  revision = 1;
  mocks.request.mockReset().mockImplementation(async (op: string, params: Record<string, any> = {}) => {
    params = JSON.parse(JSON.stringify(params)); // Match the real JSON RPC boundary, including Svelte proxies.
    if (op === "read") return { exists: true, data: JSON.parse(JSON.stringify(doc)), revision: String(revision) };
    if (op === "write") {
      if (params.revision !== String(revision)) throw new Error("conflict");
      doc = (params.mode === "namespace" ? applyNamespaces(doc, params.patch) : applyMerge(doc, params.patch)) as typeof doc;
      for (const key of params.unsetKeys ?? []) delete doc[key];
      revision++;
      return { revision: String(revision) };
    }
    return {};
  });
});
afterEach(async () => { if (instance) await unmount(instance); host.remove(); vi.useRealTimers(); });
function button(root: Element, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!b) throw new Error(`button missing: ${text}`);
  return b;
}
async function openPackage(name: string) {
  const detail = [...host.querySelectorAll("details")].find((d) => d.querySelector("summary")?.textContent?.includes(name))!;
  detail.open = true; detail.dispatchEvent(new Event("toggle"));
  await settle(); return detail;
}
it("renders the subagent namespace and really deletes roles while retaining siblings", async () => {
  instance = mount(PackageForms, { target: host });
  const detail = await openPackage("Subagent roles");
  expect(detail.textContent).toContain("coder");
  expect([...detail.querySelectorAll("textarea")].some((t) => t.value.includes("p/s"))).toBe(true);
  button(detail, "Delete role").click(); await settle();
  expect(doc.subagent.roles.coder).toBeUndefined();
  expect(doc.subagent.roles.reviewer.models).toEqual(["p/r"]);
  expect(doc.subagent.agentModels).toEqual({ scout: "p/s" });
});
it("edits permission rule names without keeping the old rule or copying unrelated settings", async () => {
  instance = mount(PackageForms, { target: host });
  const detail = await openPackage("Permissions");
  expect(detail.textContent).not.toContain("defaultProvider");
  const input = detail.querySelector("input")!;
  expect(input.value).toBe("old*");
  input.value = "new*"; input.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  expect(doc.permission).toEqual({ bash: { "new*": "deny", "keep*": "allow" } });
  expect(doc.theme).toBe("dark");
});
it("clearing a settings field performs one atomic reset-and-edit request", async () => {
  instance = mount(SettingsWorkspace, { target: host }); await settle();
  const input = host.querySelector<HTMLInputElement>("#ab-prov")!;
  input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
  button(host, "Apply & verify").click(); await settle();
  expect(doc.defaultProvider).toBeUndefined();
  expect(mocks.request.mock.calls.filter(([op]) => op === "write")).toHaveLength(1);
  expect(mocks.request.mock.calls.some(([op]) => op === "unset")).toBe(false);
  expect(host.textContent).toContain("Saved");
});
it("removes an extension override when its form is reset to the default", async () => {
  doc = { model: "custom/image-model", keep: true };
  instance = mount(SettingsWorkspace, { target: host }); await settle();
  button(host, "Models & cycling").click(); await settle();
  const input = host.querySelector<HTMLInputElement>("#media-model")!;
  expect(input.value).toBe("custom/image-model");
  input.value = ""; input.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  expect(doc.model).toBeUndefined();
  expect(doc.keep).toBe(true);
  expect(mocks.request.mock.calls.some(([op, params]) => op === "write" && params.unsetKeys?.includes("model"))).toBe(true);
});
it("sends the actual typed runtime session name", async () => {
  instance = mount(SettingsWorkspace, { target: host }); await settle();
  button(host, "Current runtime").click(); flushSync();
  const input = host.querySelector<HTMLInputElement>('input[placeholder="session name"]')!;
  vi.useFakeTimers(); vi.mocked(api.piRequest).mockClear();
  input.value = "new title"; input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(701);
  expect(api.piRequest).toHaveBeenCalledWith({ type: "set_session_name", name: "new title" }, 30, "/project", undefined);
});
