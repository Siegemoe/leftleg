# **A note from the creator**

Hi, I’m Zack, also known as Siegemoe.

I created Leftleg to satisfy my curiosity. AI agents have been an incredibly interesting development, and I’ve been fortunate enough to spend the past two years exploring their progress. I plan to continue doing so while building a deeper understanding of the software development lifecycle and the security required to protect users and their data.
Leftleg originally began as its own agent harness and runtime. I eventually ran into a problem familiar to many people building these tools: subscription access to certain models could not be used inside it.

A few months ago, I tried T3 Code and found the answer I had been missing. Instead of working around model providers, use their supported harnesses, remain within their terms of service, and build a wrapper that adapts the runtime to your preferred workflows.

Watching Theo and the T3 Code team turn an idea that was once dismissed as “just a wrapper” into a refined workspace changed how I thought about the problem. I had allowed my curiosity to lead me toward a solution far more complicated than necessary.

The T3 Code team deserves credit for demonstrating a practical way to bring different model experiences into one workspace. I do not know whether this will remain the best approach forever, but it works today and was thoughtfully designed. Leftleg’s current left panel draws clear inspiration from T3 Code, and its future approach to models, providers, and harnesses will likely continue learning from their work. I’m a fan.

Leftleg will carve out its own path as its foundations mature. There is still a mountain of work ahead before it reaches a broadly serviceable state, but I believe it will begin to shine as its own UI and workflow ideas take shape.

Current status

Leftleg is an expanding prototype. I would not call it an alpha yet, and it has not received a comprehensive security audit. It can launch coding agents with access to your files and development environment, so use it only in projects and environments where you understand that risk. Avoid sensitive, customer, or production data.

My goal is to keep building Leftleg, pushing it to become my preferred agent surface. I've made it public so others could use it, or be inspired to create their own surface.

##**Leftleg is an independent project and is not affiliated with T3 Code, Pi, or any model provider.**

# Leftleg

A native desktop control surface for the [Pi coding agent](https://github.com/earendil-works/pi-mono), built with **Tauri 2 (Rust) + Svelte 5**.

Leftleg owns only GUI concerns and treats pi's RPC protocol as the single integration surface: pi itself (spawned as `pi --mode rpc`, one process per project) stays authoritative for all agent state — sessions, credentials, extensions, settings.

**Status:** early, pre-1.0. Windows is the supported platform. Release history lives in [CHANGELOG.md](CHANGELOG.md).

## Highlights

- **Multi-project orchestration** — one pi process per project; background projects keep streaming while you work elsewhere, and focus switches without app reloads.
- **Live transcripts** — streaming assistant output with tool cards, image support, and history rebuilt from pi's own session files.
- **Steering & follow-ups** — mirror of pi's live queue; steer a running turn or line up follow-ups.
- **Extension surfaces** — extension UI requests become native dialogs, with process-ownership and expiry guards so stale prompts can't answer themselves.
- **Settings workspace** — a management bridge to pi (the `/settings-mgmt` companion): core config, extension config, and package forms, all revision-checked, atomic, and read-back verified.
- **Image generation** — the `image_generate` tool (via the `leftleg-media` companion) renders images from text prompts through OpenRouter's Image API with reference-image iteration; auth resolves inside pi, files save under `.pi/images/`, and the tool reports cost.
- **Self-updating** — startup update checks with in-app install via Tauri's signed updater (minisign-verified artifacts, turn-safe: never interrupts a running agent).

## Install

Grab the latest installer from [Releases](https://github.com/Siegemoe/leftleg/releases/latest) and run it. Leftleg checks for updates at startup and offers signed updates in-app (Settings → Updates).

Requirements:

- Windows 10/11
- [pi](https://github.com/earendil-works/pi-mono) installed globally: `npm install -g @earendil-works/pi-coding-agent`

## Development

Prerequisites: Node 22+ (see `.nvmrc`), Rust stable-msvc, MSVC Build Tools.

```powershell
npm install
npm run tauri dev
```

| Script | Purpose |
| --- | --- |
| `npm run build` | quality gate: svelte-check (0 errors / 0 warnings) + vitest + vite build |
| `npm run test` | frontend unit tests (vitest) |
| `npm run check:rust` / `npm run test:rust` | cargo check / cargo test |
| `npm run tauri build` | signed release build + NSIS installer — see `docs/RELEASE.md` |

The build gate is deliberate: template type errors and logic regressions fail at build time, not at runtime. `AGENTS.md` documents the repo's ground rules (Svelte 5 syntax only, pi owns agent state, errors never silent) — contributors, human or AI, should read it before opening a PR.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — deep dive: RPC bridge, event routing, state ownership
- [`docs/RELEASE.md`](docs/RELEASE.md) — signing keys, updater feed, per-release checklist
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's next
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — bundled third-party work (fonts, adapted code)

## Security

See [`SECURITY.md`](SECURITY.md) for reporting vulnerabilities privately and for the updater trust model (including key-compromise rotation).

## License

[MIT](LICENSE). Bundled third-party work is noted in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
