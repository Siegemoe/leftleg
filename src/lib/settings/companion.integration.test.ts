// Integration proof: the real Pi companion loaded by a REAL `pi --mode rpc`
// process in an ISOLATED agent directory. Verifies the management handshake
// (command registered), request-correlated structured replies over the notify
// channel, atomic write round trips with sibling preservation, conflict
// detection, and that management exchanges never produce model messages.
//
// No provider/network calls: PI_OFFLINE=1 + PI_SKIP_VERSION_CHECK=1, and the
// settings-mgmt command executes immediately (never an LLM turn).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// vitest runs modules under a non-file scheme; resolve the companion from the repo root.
const COMPANION_SRC = resolve(process.cwd(), "companion", "leftleg-settings", "index.ts");
const REPLY_MARKER = "LeftlegMgmt:";

interface Jsonl { [k: string]: unknown }

let agentDir = "";
let projectDir = "";
let child: ChildProcess | null = null;
let buffer = "";
const listeners: Array<(line: Jsonl) => void> = [];
let seq = 0;

function send(obj: Jsonl): void {
  child?.stdin?.write(JSON.stringify(obj) + "\n");
}

function waitEvent(type: string, predicate: (e: Jsonl) => boolean, timeoutMs: number): Promise<Jsonl> {
  return new Promise((resolvePromise, rejectPromise) => {
    const listener = (e: Jsonl) => {
      if (e.type === type && predicate(e)) {
        cleanup();
        resolvePromise(e);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    listeners.push(listener);
  });
}

async function request(cmd: Jsonl, timeoutMs = 20000): Promise<Jsonl> {
  const id = `llt-${++seq}`;
  const p = waitEvent("response", (e) => e.id === id, timeoutMs);
  send({ ...cmd, id });
  return p;
}

async function mgmtRequest(op: string, params: Record<string, unknown>, reqId: string): Promise<Record<string, unknown>> {
  const accepted = request({ type: "prompt", message: `/settings-mgmt ${JSON.stringify({ v: 1, id: reqId, op, ...params })}` });
  const reply = waitEvent("extension_ui_request", (e) => {
    const msg = (e as { message?: string }).message ?? "";
    return e.method === "notify" && msg.startsWith(REPLY_MARKER) && msg.includes(`"${reqId}"`);
  }, 20000);
  await accepted;
  const raw = ((await reply) as { message?: string }).message ?? "";
  const parsed = JSON.parse(raw.slice(REPLY_MARKER.length)) as Record<string, unknown>;
  expect(parsed.id).toBe(reqId);
  return parsed;
}

beforeAll(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "leftleg-mgmt-agent-"));
  projectDir = mkdtempSync(join(tmpdir(), "leftleg-mgmt-proj-"));
  // no settings.json pre-created: pi starts fine without it, and the first
  // companion read must honestly report exists:false (absent ≠ false)
  cpSync(COMPANION_SRC, join(agentDir, "extensions", "leftleg-settings", "index.ts"));

  child = spawn("cmd", ["/C", "pi", "--mode", "rpc"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = child.stdout!;
  let stderrTail = "";
  stdout.setEncoding("utf-8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Jsonl;
        for (const l of [...listeners]) l(parsed);
      } catch { /* non-JSON line */ }
    }
  });
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  const startupFailure = new Promise<never>((_, rejectPromise) => {
    child!.once("error", (error) => rejectPromise(new Error(`failed to start pi: ${error.message}`)));
    child!.once("exit", (code, signal) => {
      const detail = stderrTail.trim();
      rejectPromise(new Error(`pi exited before RPC became ready (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`));
    });
  });
  // wait for the process to accept requests: a get_state response means RPC is live
  await Promise.race([request({ type: "get_state" }, 30000), startupFailure]);
}, 60000);

afterAll(() => {
  child?.stdin?.end();
  child?.kill();
  for (const dir of [agentDir, projectDir]) {
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("settings companion over real pi RPC (isolated agent dir)", () => {
  it("handshake: the companion command is registered (extension loaded from the isolated agent dir)", async () => {
    const res = await request({ type: "get_commands" });
    expect(res.success).toBe(true);
    const cmds = ((res.data as { commands?: Array<{ name: string }> }).commands ?? []).map((c) => c.name);
    expect(cmds).toContain("settings-mgmt");
  });

  it("ping round trip: request-correlated structured reply over the notify channel", async () => {
    const reply = await mgmtRequest("ping", {}, "t-ping");
    expect(reply.ok).toBe(true);
    const data = reply.data as { agentDir?: string; companionVersion?: number };
    expect(data.companionVersion).toBe(1);
    // the companion resolved the ISOLATED agent dir, never the real one
    expect(data.agentDir?.toLowerCase()).toContain("leftleg-mgmt-agent");
  });

  it("write/read round trip with sibling preservation and revision conflicts", async () => {
    // initial read: settings file does not exist yet
    const first = await mgmtRequest("read", { target: "settings-global" }, "t-read0");
    expect(first.ok).toBe(true);
    expect((first.data as { exists: boolean }).exists).toBe(false);

    // write 1: nested patch creates the file
    const w1 = await mgmtRequest("write", {
      target: "settings-global",
      mode: "merge",
      patch: { compaction: { enabled: false, reserveTokens: 8192 }, retry: { maxRetries: 5 } },
    }, "t-write1");
    expect(w1.ok).toBe(true);
    const file = (w1.data as { file: string }).file;
    expect(existsSync(file)).toBe(true);

    // sibling preservation on disk
    const after1 = JSON.parse(readFileSync(file, "utf-8"));
    expect(after1.compaction).toEqual({ enabled: false, reserveTokens: 8192 });
    expect(after1.retry).toEqual({ maxRetries: 5 });

    // write 2 (stale revision): conflict, file untouched
    const w2 = await mgmtRequest("write", {
      target: "settings-global", mode: "merge", revision: "bogus:1",
      patch: { theme: "light" },
    }, "t-write2");
    expect(w2.ok).toBe(false);
    expect((w2 as { error?: string }).error).toContain("conflict");
    expect(JSON.parse(readFileSync(file, "utf-8")).theme).toBeUndefined();

    // read-back shows the saved values (authoritative resolver = the file itself)
    const read2 = await mgmtRequest("read", { target: "settings-global" }, "t-read2");
    const data = (read2.data as { data: { compaction?: { enabled?: boolean } } }).data;
    expect(data.compaction?.enabled).toBe(false);
  });

  it("management exchanges never produce model messages or agent turns", async () => {
    let modelEvents = 0;
    const listener = (e: Jsonl) => {
      if (e.type === "message_start" || e.type === "message_update" || e.type === "agent_start") modelEvents++;
    };
    listeners.push(listener);
    await mgmtRequest("ping", {}, "t-quiet");
    await new Promise((r) => setTimeout(r, 500)); // let any stray events arrive
    listeners.splice(listeners.indexOf(listener), 1);
    expect(modelEvents).toBe(0);
  });

  it("read-only and allowlist protections hold over the real process", async () => {
    const store = await mgmtRequest("write", { target: "models-store", mode: "replace", content: "{}" }, "t-ro");
    expect(store.ok).toBe(false);
    expect((store as { error?: string }).error).toContain("read-only");

    const bad = await mgmtRequest("read", { target: "../../real-pi-config" }, "t-allow");
    expect(bad.ok).toBe(false);
  });
});
