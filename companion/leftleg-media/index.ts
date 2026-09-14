/**
 * Leftleg media companion — image generation for pi agents.
 *
 * Loaded as a global extension (~/.pi/agent/extensions/leftleg-media/index.ts),
 * independent of project trust. Registers ONE tool, `image_generate`, which
 * calls OpenRouter's dedicated Image API (POST /api/v1/images) — paid network
 * work only ever happens as an explicit, agent-visible tool call.
 *
 * Credential discipline: the API key is resolved through pi's own model
 * registry (ctx.modelRegistry.getProviderAuth("openrouter"), which resolves
 * stored API keys and OAuth credentials alike). The key is held in a local
 * variable for the duration of one request and never written to disk, logs,
 * the transcript, or the tool result.
 *
 * Storage: images are saved project-scoped under `<project>/.pi/images/`
 * (timestamped, prompt-slugged names) with tmp+rename atomic writes — the
 * same pattern as the settings companion. The tool result returns the saved
 * paths plus OpenRouter's reported cost, so agents can reference the files
 * (and pass them back as `reference_images` to iterate) and users see cost
 * in the tool card.
 *
 * Billing note (OpenRouter): image generation is all-or-nothing — failed or
 * aborted generations are not billed.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IMAGES_API_URL = "https://openrouter.ai/api/v1/images";
const DEFAULT_MODEL = "google/gemini-3.1-flash-image";
const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

interface ImageGenParams {
  prompt: string;
  model?: string;
  resolution?: "512" | "1K" | "2K" | "4K";
  aspect_ratio?: string;
  quality?: "auto" | "low" | "medium" | "high";
  output_format?: "png" | "jpeg" | "webp" | "svg";
  background?: "auto" | "transparent" | "opaque";
  n?: number;
  reference_images?: string[];
}

interface ImageApiResponse {
  created?: number;
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { cost?: number; total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return slug.slice(0, 40) || "image";
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function extFor(mediaType: string | undefined): string {
  switch (mediaType) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/gif": return "gif";
    default: return "png";
  }
}

function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function writeFileAtomic(file: string, data: Buffer): void {
  const tmp = join(file, "..", `.${file.split(/[\\/]/).pop() ?? "img"}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { renameSync(tmp, file); } catch { /* second attempt on transient sharing violations */ }
    if (!statSync(file, { throwIfNoEntry: false })) throw e;
  }
}

function readReference(path: string): string {
  const abs = resolve(path);
  const buf = readFileSync(abs);
  if (buf.length > MAX_REFERENCE_BYTES) {
    throw new Error(`${path}: reference image exceeds 10 MiB limit`);
  }
  const mime = sniffMime(buf);
  if (!mime) {
    throw new Error(`${path}: not a readable png/jpeg/gif/webp image`);
  }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "image_generate",
    label: "Generate image",
    description:
      "Generate images from a text prompt via OpenRouter's Image API. Supports reference images (image-to-image iteration), resolution/aspect/quality/format options, and 1-10 images per call. Saves files under .pi/images/ in the project and returns their paths plus the reported cost. Billing is all-or-nothing: failed calls cost nothing.",
    promptSnippet: "Generate or iterate on images from text prompts (OpenRouter Image API)",
    promptGuidelines: [
      "Use image_generate when the user asks to create, draw, render, or generate an image, or to iterate on an existing image.",
      "image_generate saves files under .pi/images/ and returns their paths — cite those paths in your reply, and pass one or more of them as reference_images to iterate on a previous result.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Text description of the image to render." }),
      model: Type.Optional(Type.String({ description: `OpenRouter image model slug (e.g. google/gemini-3.1-flash-image, openai/gpt-image-1, bytedance-seed/seedream-4.5). Default: ${DEFAULT_MODEL}.` })),
      resolution: Type.Optional(Type.Union([Type.Literal("512"), Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")], { description: "Resolution tier; providers clamp to what they support." })),
      aspect_ratio: Type.Optional(Type.String({ description: "Aspect ratio like 1:1, 16:9, 9:16, 4:3, 3:2, 21:9 — or 'auto'. Providers clamp unsupported values." })),
      quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Quality knob; providers without one ignore it." })),
      output_format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp"), Type.Literal("svg")], { description: "Output format; provider default applies when omitted." })),
      background: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("transparent"), Type.Literal("opaque")], { description: "'transparent' requires a png/webp-capable model." })),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Images to generate (1-10); single-image providers reject n > 1." })),
      reference_images: Type.Optional(Type.Array(Type.String({ description: "Local image path to use as a reference (image-to-image)." }), { maxItems: MAX_REFERENCES, description: "Read inside pi and sent as base64 data URLs." })),
    }),
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as ImageGenParams;
      const model = params.model?.trim() || DEFAULT_MODEL;

      // Auth: resolved through pi's registry (stored key or OAuth) — the key
      // lives only in this closure for the duration of the request.
      const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
      const apiKey = auth?.auth?.apiKey;
      if (!apiKey) {
        throw new Error("No OpenRouter credential configured in pi — set one with /login (OpenRouter) or an OpenRouter API key, then retry.");
      }

      const references = (params.reference_images ?? []).map(readReference);

      const body: Record<string, unknown> = { model, prompt: params.prompt };
      if (params.resolution !== undefined) body.resolution = params.resolution;
      if (params.aspect_ratio !== undefined && params.aspect_ratio !== "") body.aspect_ratio = params.aspect_ratio;
      if (params.quality !== undefined) body.quality = params.quality;
      if (params.output_format !== undefined) body.output_format = params.output_format;
      if (params.background !== undefined) body.background = params.background;
      if (params.n !== undefined) body.n = params.n;
      if (references.length > 0) body.input_references = references;

      onUpdate?.({ content: [{ type: "text", text: `Rendering with ${model}… (typically 10-90s)` }] });

      const res = await fetch(IMAGES_API_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 500);
        try {
          const parsedErr = JSON.parse(text) as ImageApiResponse;
          if (parsedErr?.error?.message) message = parsedErr.error.message;
        } catch { /* non-JSON error body */ }
        throw new Error(`OpenRouter images request failed (${res.status}): ${message}`);
      }

      const parsed = JSON.parse(text) as ImageApiResponse;
      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
      const dir = join(cwd, ".pi", "images");
      mkdirSync(dir, { recursive: true });

      const stamp = timestamp();
      const slug = slugify(params.prompt);
      const data = parsed.data ?? [];
      const saved: string[] = [];
      for (const [i, item] of data.entries()) {
        if (!item.b64_json) continue;
        const bytes = Buffer.from(item.b64_json, "base64");
        const suffix = data.length > 1 ? `-${i + 1}` : "";
        const file = join(dir, `${stamp}-${slug}${suffix}.${extFor(item.media_type)}`);
        writeFileAtomic(file, bytes);
        saved.push(file);
      }
      if (saved.length === 0) {
        throw new Error("OpenRouter returned no images for this request.");
      }

      const cost = typeof parsed.usage?.cost === "number" ? parsed.usage.cost : undefined;
      const summary = [
        `Saved ${saved.length} image${saved.length > 1 ? "s" : ""} (${model}):`,
        ...saved,
        cost !== undefined ? `Reported cost: $${cost.toFixed(4)}` : undefined,
      ].filter((line) => line !== undefined).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { paths: saved, model, usage: parsed.usage ?? null, references: references.length },
      };
    },
  });
}
