# Research: image generation for Leftleg via OpenRouter

Date: 2026-09-13. Method: research skill — primary sources (installed pi 0.85.1 source/docs + OpenRouter official docs), every claim linked to its source.

## Research question

Add a tool to call OpenRouter image-generation agents, save generated images to a managed location, and support iterating on images over time. Does Pi already provide a module for this, and how should it be built against pi 0.85.1 + Leftleg?

## Findings

### 1. Pi 0.85.1 has no native image-generation capability

- Searched `@earendil-works/pi-coding-agent` docs and type exports: **no `generateImage`, `image_gen`, or output-image support anywhere**. Image machinery is INPUT-only: `resizeImage`/`convertToPng`/`detectSupportedImageMimeTypeFromFile` in `dist/utils/image-*.ts` and the `ImageSettings` settings type (attachment resizing, 2000×2000 max, blocking). Source: installed `PI_ROOT/docs/settings.md` ("Terminal & Images"), `PI_ROOT/dist/index.d.ts`.
- Conclusion: generation must arrive as a **custom extension tool** (public API: `pi.registerTool`, docs/extensions.md) — there is no harness-native path, and none should be invented.

### 2. OpenRouter has a dedicated Image API (not chat-completions hacks)

Source: https://openrouter.ai/docs/features/multimodal/image-generation (extracted 2026-09-13).

- **Generation**: `POST /api/v1/images` with `{ model, prompt, ...options }`.
- **Discovery**: dedicated image-models endpoint + the general Models API (`output_modalities=image`); per-endpoint records expose `supported_parameters` (typed enum/range/boolean descriptors), `allowed_passthrough_parameters`, `pricing` with billable units like `output_image` / `input_reference` (per image or megapixel).
- **Options**: `resolution` (512/1K/2K/4K tiers), `aspect_ratio` (1:1, 16:9, … providers clamp), `size` shorthand (tier or explicit pixels), `quality` (auto/low/medium/high), `output_format` (png/jpeg/webp/svg), `background` (auto/transparent/…). Mismatched `size` + `resolution`/`aspect_ratio` → 400.
- **Response**: base64 image bytes with `media_type` (png/jpeg/webp/svg) + `usage` (token counts/cost when available).
- **Reference images** are supported (text prompt + optional reference images) — iteration/chains are a first-class API feature, exactly what "iterate on those images over time" needs.

### 3. Credentials must stay inside Pi

Pi's auth storage holds the user's OpenRouter OAuth credential (inventory §auth). Leftleg must not read, move, or re-derive it. The generation tool must run **inside a pi extension process**, resolving auth through pi's own provider mechanisms, so no secret ever enters Leftleg state, logs, RPC args, or the transcript.

## Proposed architecture

1. **Tool layer (pi extension, new `leftleg-media` alongside the settings companion)**
   - Registers an agent tool `image_generate` with input `{ prompt, model?, resolution?, aspect_ratio?, size?, quality?, output_format?, reference_images?: string[] (paths to previously saved images) }`.
   - Calls `POST /api/v1/images` with auth resolved via pi's provider credential mechanism (verify the exact public extension API for auth retrieval before build — `docs/extensions.md`; do not read auth files directly).
   - Saves bytes to `<project>/.pi/images/YYYYMMDD-HHMMSS-<slug>.<ext>` (project-scoped by default; an optional global dir can be set later) using the same atomic-write pattern as the settings companion.
   - Tool result returns the saved path + reported cost — the agent can then `read`/reference the file, and users see cost in the tool card.
   - All network calls are tool-invoked (explicit work the agent was asked to do), never background or settings-time.
2. **Leftleg layer (management + iteration UX)**
   - **Images panel**: gallery of `<project>/.pi/images/` via a guarded Tauri command (list + delete/move); display via the existing `read_file_base64` path (size-capped like the chat).
   - **Iteration**: "use as reference" on any gallery item → attaches it to the composer as an input image, or the agent chains `reference_images` itself through the tool.
   - **Costs**: aggregate the tool results' reported costs per session (tool cards already render output).
3. **Settings layer**
   - New `leftleg-media` namespace in global settings.json (namespace-merge via the existing companion): `defaultModel`, `resolution`, `aspectRatio`, `quality`, `outputFormat`, `storageDir` (project-scoped default), `maxImagesPerRun` guardrail.
   - Workspace: new "Media & images" controls under Extensions & packages + a per-project default via the existing project-meta machinery if needed.
4. **Safety**
   - No credentials in GUI state/logs/args (tool runs inside pi).
   - Explicit user intent for every paid call; cost surfaced from the API response.
   - Project `.pi/images` writes are ordinary tool writes — trust semantics unchanged.

## Open questions to verify at build time

1. The public extension API for resolving provider credentials (extensions.md mentions provider warning events; the exact auth accessor needs verification — a wrong guess would force reading auth files, which is off-limits).
2. Image-API auth header shape for OAuth-sourced keys (`Authorization: Bearer` expected; token validity for the Image endpoint specifically).
3. Whether pi's tool-schema registration supports streaming tool updates for long generations (gpt-image-2 took ~94s in the docs example — progress feedback matters).
4. Multi-model pricing display from the per-endpoint `pricing` records (image vs megapixel units).

## Sources

- OpenRouter Image Generation docs: https://openrouter.ai/docs/features/multimodal/image-generation
- OpenRouter models filtered by image output: https://openrouter.ai/models?output_modalities=image
- Installed pi 0.85.1: `PI_ROOT/docs/settings.md`, `PI_ROOT/dist/index.d.ts`, `PI_ROOT/docs/extensions.md` (tool registration; auth accessor to verify)
- Leftleg: `companion/leftleg-settings/` (file-write + revision patterns to reuse), `src/lib/stores.ts` (attachment path), `docs/PI_SETTINGS_INVENTORY.md` (auth metadata)
