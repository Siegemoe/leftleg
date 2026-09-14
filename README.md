# Leftleg

A native desktop control surface for the [Pi coding agent](https://github.com/earendil-works/pi-mono), built with **Tauri 2 (Rust) + Svelte 5**.

Leftleg owns only GUI concerns and treats pi's RPC protocol as the single integration surface: pi itself (spawned as `pi --mode rpc`, one process per project) stays authoritative for all agent state — sessions, credentials, extensions, settings.

**Status:** early, pre-1.0 (v0.2.0). Windows is the supported platform.

## Highlights

- **Multi-project orchestration** — one pi process per project; background projects keep streaming while you work elsewhere, and focus switches without app reloads.
- **Live transcripts** — streaming assistant output with tool cards, image support, and history rebuilt from pi's own session files.
- **Steering & follow-ups** — mirror of pi's live queue; steer a running turn or line up follow-ups.
- **Extension surfaces** — extension UI requests become native dialogs, with process-ownership and expiry guards so stale prompts can't answer themselves.
- **Settings workspace** — a management bridge to pi (the `/settings-mgmt` companion): core config, extension config, and package forms, all revision-checked, atomic, and read-back verified.
- **Self-updating** — startup update checks with in-app install via Tauri's signed updater (minisign-verified artifacts, turn-safe: never interrupts a running agent).

## Install

Grab the latest installer from [Releases](https://github.com/Siegemoe/leftleg/releases/latest) and run it. Leftleg checks for updates at startup and offers signed updates in-app (Settings → Updates).

Requirements:

- Windows 10/11
- [pi](https://github.com/earendil-works/pi-mono) installed globally: `npm install -g @earendil-works/pi-coding-agent`

## Development

Prerequisites: Node 20+, Rust stable-msvc, MSVC Build Tools.

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
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — bundled third-party work (fonts, adapted code)

## Security

See [`SECURITY.md`](SECURITY.md) for reporting vulnerabilities privately and for the updater trust model (including key-compromise rotation).

## License

[MIT](LICENSE). Bundled third-party work is noted in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
