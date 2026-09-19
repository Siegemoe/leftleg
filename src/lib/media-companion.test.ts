import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerMedia from "../../companion/leftleg-media/index";

let root = "";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64");

function execute(params: Record<string, unknown>, signal = new AbortController().signal) {
  // Only the shape these tests read back; the real tool returns more fields.
  let tool!: { execute: (...args: unknown[]) => Promise<{ details: { paths: string[] } }> };
  registerMedia({ registerTool: (definition: unknown) => { tool = definition as typeof tool; } } as never);
  return tool.execute("test", params, signal, undefined, {
    cwd: root, modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) },
  });
}

function response(data: unknown) {
  return { ok: true, text: async () => JSON.stringify({ data }) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leftleg-media-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:34:56.789Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("media companion output durability", () => {
  it("resolves relative references against the active project", async () => {
    writeFileSync(join(root, "reference.png"), png);
    const fetch = vi.fn().mockResolvedValue(response([{ b64_json: png.toString("base64") }]));
    vi.stubGlobal("fetch", fetch);
    await execute({ prompt: "iterate", reference_images: ["reference.png"] });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.input_references[0].image_url.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("uses the actual raster format when the response omits media_type", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{ b64_json: gif.toString("base64") }])));
    const result = await execute({ prompt: "gif" });
    expect(result.details.paths[0]).toMatch(/\.gif$/);
    expect(readFileSync(result.details.paths[0])).toEqual(gif);
  });

  it("rejects malformed image data before saving any part of a batch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([
      { b64_json: png.toString("base64") }, { b64_json: "%%%%" },
    ])));
    await expect(execute({ prompt: "batch", n: 2 })).rejects.toThrow(/image/i);
    const images = join(root, ".pi", "images");
    expect(existsSync(images) ? readdirSync(images) : []).toEqual([]);
  });

  it("does not save results after cancellation while reading the response", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => {
      controller.abort();
      return JSON.stringify({ data: [{ b64_json: png.toString("base64") }] });
    } }));
    await expect(execute({ prompt: "cancel" }, controller.signal)).rejects.toThrow();
    expect(existsSync(join(root, ".pi", "images"))).toBe(false);
  });

  it("keeps both images when identical prompts finish in the same millisecond", async () => {
    let tool: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
    registerMedia({ registerTool: (definition: unknown) => { tool = definition as typeof tool; } } as never);
    const payload = png.toString("base64");
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
