// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import companion, { computeRevision } from "../../../companion/leftleg-settings/index";

let dir: string;
let handler: (args: string, ctx: never) => Promise<void>;
let activeTools: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "leftleg-safety-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  activeTools = ["read", "bash"];
  companion({
    registerCommand: (_: string, options: { handler: typeof handler }) => { handler = options.handler; },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as never);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
// Structured mgmt replies as read by these tests (subset of the real shape).
type MgmtReply = { ok?: boolean; data?: { activeTools?: string[] } };
async function request(op: string, params: Record<string, unknown> = {}) {
  let reply: MgmtReply = {};
  await handler(JSON.stringify({ v: 1, id: "test", op, ...params }), {
    cwd: dir, ui: { notify: (message: string) => { reply = JSON.parse(message.slice("LeftlegMgmt:".length)); } },
  } as never);
  return reply;
}
describe("companion boundary regressions", () => {
  it("applies resets and edits as one revision-checked write", async () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ retry: { enabled: false, maxRetries: 3 }, theme: "dark" }));
    const result = await request("write", { target: "settings-global", revision: computeRevision(file),
      mode: "merge", unsetKeys: ["retry.enabled"], patch: { retry: { maxRetries: 5 } } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ retry: { maxRetries: 5 }, theme: "dark" });
  });
  it("rejects raw writes to the generated models cache", async () => {
    const file = join(dir, "models-store.json");
    writeFileSync(file, '{"keep":true}');
    expect((await request("write-raw", { target: "models-store", content: "{}" })).ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe('{"keep":true}');
  });
  it("detects same-size external edits even if mtime is preserved", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"value":1}');
    const fixed = new Date("2026-01-01T00:00:00Z");
    utimesSync(file, fixed, fixed);
    const rev = computeRevision(file);
    writeFileSync(file, '{"value":2}');
    utimesSync(file, fixed, fixed);
    expect(statSync(file).mtimeMs).toBe(fixed.getTime());
    expect(computeRevision(file)).not.toBe(rev);
  });
  it("gets and sets tools through ExtensionAPI, not ExtensionContext", async () => {
    expect((await request("get-runtime")).data?.activeTools).toEqual(["read", "bash"]);
    expect((await request("set-active-tools", { tools: ["read"] })).ok).toBe(true);
    expect(activeTools).toEqual(["read"]);
  });
  it("rejects null requests with a structured reply", async () => {
    let reply: MgmtReply = {};
    await expect(handler("null", { ui: { notify: (m: string) => { reply = JSON.parse(m.slice("LeftlegMgmt:".length)); } } } as never)).resolves.toBeUndefined();
    expect(reply.ok).toBe(false);
  });
});
