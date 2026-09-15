# Image generation audit — 2026-09-15

Baseline: Leftleg 0.3.0, local commit `14df864`.

## Reported image-opening failure

The baseline already contains the `opener:allow-open-path` scope fix. The installed executable's modification time predates that commit; the running process uses the installed executable. A rebuilt app is needed to activate the source fix. A Windows integration regression now loads the actual capability configuration into Tauri's filesystem scope and verifies a `.pi/images` file with repeated path separators, matching the reported path shape. This verifies permission matching; it does not launch the user's image viewer.

## Fixed in this round

- Resolve image references relative to Pi's current project directory, rather than the extension process's working directory.
- Infer raster output types from their signatures when the response omits `media_type`, avoiding incorrectly named PNG files. The [OpenRouter Image API reference](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) documents base64 image responses and optional media types.
- Reject invalid base64 and unsupported image signatures. Validate every returned image before writing a batch, so a malformed later response entry does not leave an earlier image behind. This is format validation, not complete image decoding or transactionality across disk-write failures.
- Respect cancellation after reading the response body, before saving images.
- Deduplicate tool-result paths before Svelte renders keyed image previews.
- Refresh the visible artifact gallery when image generation completes.
- Retry failed thumbnails when the user refreshes the gallery.
- Correct total-response timing: use completion time, make the `agent_start` fallback reachable when no `turn_start` arrives, and notify the UI after normal message completion clears the streaming pointer.

The media tool description also distinguishes a local save failure from provider billing outcomes.

## Verification

- `npm run build`: Svelte check has zero errors and warnings; 208 tests across 24 files pass; Vite production build passes.
- `npm run check:rust`: passes.
- `npm run test:rust`: 41 unit tests and the Windows opener integration test pass.
- `npm run tauri -- build --no-bundle`: passes after the final source edit. The executable contains the final `index-BohN4wYi.js` asset name, not the earlier bundle's name. SHA-256: `ED46FAF156B8546CF30235E03330F9B8A18C5A146A3D65A9437C86EE87B42459`.
- New frontend regressions were observed failing before their fixes.
- Image API tests mock network responses; no paid generation was requested.
- Native integration tests explicitly link the Windows Common Controls v6 manifest required by Tauri's mock application.

## Activation and limits

The standalone executable was built with `npm run tauri -- build --no-bundle`. This includes Tauri's production protocol and the current frontend and companion sources. Close the older application before launching `src-tauri/target/release/leftleg.exe`.

In the rebuilt app, use Settings → Advanced → Reinstall for the companions, then restart the Pi process to load the updated media extension. Building the executable alone does not replace an already installed extension or reload a running Pi process.

This round covers image generation, image previews, artifact refresh, permission matching, and the related response timer. Manual desktop click-through and a live provider generation remain outside the automated verification. The changes do not establish a clean bill of health for unrelated application areas.
