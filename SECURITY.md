# Security policy

## Reporting a vulnerability

Please report security issues **privately**, via GitHub's *Security → Report a
vulnerability* on this repository — not as a public issue. Include reproduction
steps and affected versions. You can expect an initial response within a few
days; fixes land in the next release and are noted in the changelog.

## Scope

- The Rust RPC bridge (`src-tauri/src/`) — process spawning, JSONL framing,
  file handling.
- The webview frontend (`src/`) — markdown sanitization, settings management,
  update flow.
- The settings companion (`companion/leftleg-settings/`) — file writes, merge
  semantics.
- The media companion (`companion/leftleg-media/`) — image generation,
  reference reads, response caps.
- The updater chain — feed, signatures, install.

## Updater trust model

- Update artifacts are **minisign signature-verified** against a public key
  embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Unsigned
  or wrongly-signed payloads are rejected before install.
- Artifacts are only fetched from the configured GitHub Releases endpoint over
  HTTPS.
- Install is **turn-safe**: the agent is never interrupted; downloads and
  installs happen only when the user accepts them, and a running turn blocks
  installation.

## If the signing key is compromised

The private key lives **outside the repository** (default:
`~/.tauri/leftleg.key`) and must never be committed. If it leaks:

1. Generate a fresh keypair: `npm run tauri signer generate -w ~/.tauri/leftleg.key`.
2. Replace `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` with the new
   public key (see `docs/RELEASE.md`).
3. Cut a release built with the new key. One manual re-install is unavoidable:
   already-installed apps verify against the OLD embedded key and will reject
   new signatures — announce the rotation in the release notes.
4. Consider the old artifacts burned; delete or supersede affected releases.

## Supported versions

Only the latest release receives fixes. Older builds should update in-app
(Settings → Updates) or reinstall from Releases.

## Known limitations

- The updater feed is a single GitHub `latest.json` — availability depends on
  GitHub Releases.
- [`docs/AUDIT-2026-09-17.md`](docs/AUDIT-2026-09-17.md) records the last full
  source audit, including acknowledged residual risks (e.g. the microsecond
  revision-check window in companion writes; no cross-process file locking)
  and the accepted glib advisory tracked in `.cargo/audit.toml`.
