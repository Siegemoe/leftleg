import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerMedia from "../../companion/leftleg-media/index";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leftleg-media-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:34:56.789Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("media companion output durability", () => {
  it("keeps both images when identical prompts finish in the same millisecond", async () => {
    let tool: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
    registerMedia({ registerTool: (definition: unknown) => { tool = definition as typeof tool; } } as never);
    const payload = Buffer.from("generated-image").toString("base64");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: [{ b64_json: payload, media_type: "image/png" }] }),
    }));
    const context = {
      cwd: root,
      modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) },
    };

    await tool!.execute("one", { prompt: "same prompt" }, new AbortController().signal, undefined, context);
    await tool!.execute("two", { prompt: "same prompt" }, new AbortController().signal, undefined, context);

    const files = readdirSync(join(root, ".pi", "images"));
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    expect(files.every((name) => !name.startsWith("."))).toBe(true);
  });
});
