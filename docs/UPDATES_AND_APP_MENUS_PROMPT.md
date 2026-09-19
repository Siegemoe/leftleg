# Implementation prompt: automatic updates and File / Edit / View / Help

Implement automatic update discovery and a proper application menu bar in Leftleg. Read `C:/dev/active/pi-agent-gui/AGENTS.md` first, inspect the current checkout, preserve unrelated changes, then implement and verify. Do not stop at a proposal.

## Outcome

Leftleg checks for new published versions shortly after startup and periodically while open. I can see release notes, download an update, and install/restart from the application without finding and running another installer manually. Updates must not unexpectedly interrupt agent work. Replace the in-app Leftleg branding strip with functional File, Edit, View, and Help menus.

Success: an installed version A discovers a newer signed version B, completes an in-app update, reopens the correct installed executable, and reports B's actual build identity. Menus remain available with the sidebar hidden and correctly operate the focused control/current project.

Failure: version labels change but an old binary still starts; an update interrupts background Pi work; checking for updates launches an installer; Edit → Undo invokes a destructive agent checkpoint operation; menus are decorative labels or only accessible by mouse.

Proof: state/lifecycle tests, mounted UI interaction tests, and a packaged Windows A→B update in an isolated test installation. A successful build or mocked update notification alone is not end-to-end proof.

## Current baseline — recheck before implementation

At inspection (2026-09-13, commit `72ba914`): Tauri 2 + Svelte 5; NSIS bundling; native window decorations enabled; version `0.1.0` in package.json, Cargo.toml and tauri.conf.json. No updater dependency/configuration, Git remote, or `.github` release workflow was present. The visible in-app `Leftleg` wordmark is in `src/components/Sidebar.svelte`'s `.brand` row; `src/App.svelte` has a separate project topbar. Pi processes are owned per project. Composer drafts/attachments have component-local state; do not assume restarting preserves them.

Inspect `src/App.svelte`, `src/components/Sidebar.svelte`, `Composer.svelte`, `ContextMenu.svelte`, `SettingsModal.svelte`, `StatusBar.svelte`, `src/lib/stores.ts`, `src-tauri/src/lib.rs`, `pi.rs`, `sessions.rs`, Tauri config/capabilities, package manifests, and `vite.config.ts`.

Coordinate with any newly implemented Settings workspace: updates belong to **Leftleg application settings**, not Pi configuration. This task updates Leftleg only, not Pi, npm packages, extensions, model credentials, or user projects.

## Supported implementation references

- Tauri 2 supports signed updater artifacts, a public verification key, and an HTTPS static manifest, including GitHub Releases. Configure `bundle.createUpdaterArtifacts: true`, initialize the updater plugin, and grant the appropriate capabilities. Windows NSIS updates can use the installer and its generated signature; the default passive install mode displays progress. Updater signatures are distinct from Windows Authenticode signing. Check dependency/toolchain compatibility; the updater guide lists Rust 1.77.2 as its minimum. [Updater guide](https://v2.tauri.app/plugin/updater/)
- The updater API supports separate check/download/install steps and disposable update handles. On Windows installation launches the installer and exits the app; do all shutdown preparation **before** calling install. Do not depend on JavaScript after that call to save state or stop Pi. Follow the actual installed API for relaunch behavior and avoid a competing second relaunch. [Updater API](https://v2.tauri.app/reference/javascript/updater/)
- Use a Windows release workflow based on the current Tauri action. Its current inputs include `uploadUpdaterJson`, `updaterJsonPreferNsis`, `releaseDraft`, and `tagName`; verify the pinned version rather than copying obsolete examples. [Tauri action](https://github.com/tauri-apps/tauri-action), [GitHub pipeline guide](https://v2.tauri.app/distribute/pipelines/github/)
- Tauri provides menus, submenus, accelerators, and predefined editing items. Use them where appropriate rather than synthesizing fake keyboard events. [Window menus](https://v2.tauri.app/learn/window-menu/)

## 1. Discovery policy and update experience

Use **published stable GitHub Releases plus client polling** for v1. A source-code push is not an application release. No persistent push service, inbound webhook listener, background Windows service, or embedded GitHub token is needed for this design. Keep the update service modular enough for a different feed later.

Defaults (product choices, not claims about Codex internals):

- Check once after the first usable window renders, approximately 10 seconds after startup; never block startup/Pi connection.
- While the app runs, check every six hours with small jitter. After sleep/reconnect, check if overdue instead of replaying missed intervals. Coalesce foreground, startup, periodic and manual requests so only one check runs at a time.
- Help → Check for Updates checks immediately and gives an explicit result. Automatic successful no-update checks stay quiet. Transient automatic errors remain visible in update diagnostics without repeated toasts; manual failures show a clear retry action.
- Show a restrained persistent update indicator plus at most one announcement per version. Dismissing an announcement does not hide the update from Help/Settings. Newer versions can announce again.
- Default: automatically check, download on user action, install/restart on user action. Offer an optional **Automatically download updates** setting; it must not also enable automatic installation/restart. Downloading can happen while working.
- Settings contains automatic-check preference, optional automatic download, current/latest version, release notes/date, last successful check, last attempt/error, and Check now. Manual checking remains available when automatic checks are off.

Use a single update state machine shared by the menu, update indicator and settings: unconfigured/idle/checking/up-to-date/available/downloading/ready-to-install/preparing-to-install/installing/error. Do not regress ready-to-install to idle when a timer fires. Show downloaded bytes and determinate progress only when total size is known. Handle retries, superseded versions and disposal of stale update handles. Do not promise download cancellation or persistence across app restarts unless the implemented API/storage actually supports it.

Release notes are untrusted remote content: use the existing safe renderer or plain text; do not execute embedded HTML/scripts. Never log signing secrets, authentication headers or private download URLs.

## 2. Safe install, exit and restart

Separate download from installation. **Install and restart** is the disruptive boundary. Do not call downloadAndInstall from the startup check, interval callback, notification creation, or auto-download setting.

Before installing, inspect all owned projects, not only the visible conversation: streaming turns, queued work, extension questions, active subagents and background tasks when observable, pending settings writes, unsent drafts and attachments. Pi idle is not proof its extension-owned background work has ended. Add the narrow status integration necessary or disclose unknown activity and require an explicit close decision; never represent unknown as safe.

If work or unsaved input would be lost, keep the update ready and explain what needs attention. Do not add an automatic idle restart in this version. Recheck at the moment of installation, prevent new work from starting during final shutdown preparation, and release that lock if preparation fails. When preserving drafts is supported, persist only GUI-owned draft data, not duplicate Pi transcripts; otherwise let me resolve the drafts before proceeding.

Flush GUI preferences and current project/session references. Use Pi's supported shutdown behavior for every owned process, await shutdown with a bounded timeout, and distinguish intentional exits from crashes. Do not orphan processes or silently kill external tasks. If a process cannot close safely, return to a recoverable ready/error state; a force-close choice must identify the affected work. Preserve provider credentials, Pi configuration and session files.

Use the same guarded application-exit path for File → Exit/window close where feasible, so update shutdown does not introduce a conflicting lifecycle. Account for installer handoff and relaunch without duplicate Pi processes. Confirm the reopened app resumes the intended persisted session rather than blindly starting fresh; show restore failures honestly.

## 3. Release pipeline, signing and version identity

Implement the complete producer/consumer path. A check button with no usable release feed is not the finished update feature.

- Add a documented Windows release workflow triggered by an intentional version tag and/or manual dispatch; do not publish every development commit. Run the repository's frontend and Rust checks before packaging with `npm run tauri build`.
- Keep package/Tauri/Cargo versions synchronized with a version script or validation step. Use monotonically increasing SemVer for releases; commit hashes belong in build metadata/diagnostics, not homemade update ordering. Refuse tag/build-version mismatches, same-version replacement, and accidental stable-feed prereleases. Publish a higher patch version to revert code; do not disable normal version checks for casual downgrades.
- Build from the exact tagged commit with locked dependencies. Sign artifacts using a persistent private signing key kept outside the repo and supplied securely to CI; embed only its public key in the application. Do not generate a new signing identity for every release or print/export private key material in logs. Document secure initial setup and backup/rotation constraints.
- Produce the NSIS artifact, signature and a valid update manifest. Include only architectures actually built/tested; validate version, architecture, signature content and download targets. URLs must identify immutable versioned assets, not a mutable filename that could mismatch its manifest/signature.
- Create/upload to a draft release, validate the complete artifact set, then publish/set latest only when all required assets are ready. A failed build/upload must not advance the live feed. Do not mutate already published signed assets under the same version.
- Keep the application identifier and intended install scope/location stable across updates. Support the existing per-user installation path; verify Start Menu shortcuts and startup targets continue to launch that same installation. Distinguish installed releases from ad-hoc copies and dev binaries; do not quietly update a different copy on disk.
- Development builds should show their build identity and keep production polling/install disabled by default. Use an explicit test configuration for updater integration checks.
- Add About/diagnostics showing the actual native app version, build commit, build time, architecture, running executable path, update channel and feed status. Reconcile the frontend build identity with the native binary. Copy diagnostics excludes secrets and transcripts. Confirm the post-update version from the new process, not a persisted expected-version string.

No Git remote was configured at inspection. Do not invent the owner/repository, change repository visibility, create a repository, or publish anything without the user's chosen destination. Make the endpoint/release destination explicit build configuration; unresolved values must appear as **Updates not configured**, never Up to date. Release builds intended for distribution must fail validation if signing/feed configuration is incomplete.

If source is private, do not assume a GitHub release download is anonymously accessible or embed a long-lived personal access token in the binary. Support an explicitly chosen release distribution location; a separate public artifact-only repository is one option, not permission to publish private code. Complete local implementation/tests and present remaining repository/key/CI setup as concrete prerequisites.

Document the bootstrap: today's installer has no updater, so one final manual installation of the updater-enabled build is needed. Following versions use the in-app flow. Also document recovery using a known-good signed installer if an update fails. Updater signing does not itself guarantee Windows SmartScreen reputation.

## 4. Replace the brand strip with application menus

Target the current **in-app** wordmark, not the product name or application identifier. Remove the Sidebar `.brand` icon/text row and replace that chrome with a top-level File / Edit / View / Help menu bar that remains visible independently of sidebar collapse. Reconcile the project topbar so this does not produce stacked empty title strips. Keep existing typography/theme, project context, sidebar toggle, resize behavior and Windows window controls.

Retain native Windows decorations for this task. Do not redesign the OS caption/titlebar or add frameless-window drag/resize complexity merely to remove the in-app wordmark. Place the application menus at the top left of the shared app chrome. Prefer native menu/submenu/editing behavior where it fits; if a Svelte menubar is required for the placement, implement the full keyboard/focus contract. Do not display duplicate native and web menu bars.

Use one command/action registry for menus and shortcuts, delegating to existing stores/services. Compute enabled/checked state from live application state; do not duplicate business logic in each menu item. Reserve separators for action groups. Do not add placeholders for unsupported features.

| Menu     | Required actions and behavior                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File** | New Session (`Ctrl+N`); Open Project (`Ctrl+Shift+O`); Export Current Session as HTML; separator; Close Window / Exit using the guarded lifecycle. Reuse existing session/project actions and disable or guard them during unsafe transitions. Export is disabled with no session. Recent Projects only if the current project registry supports it.                               |
| **Edit** | Undo (`Ctrl+Z`), Redo (`Ctrl+Y`, with platform conventions as appropriate), Cut/Copy/Paste/Select All; separator; Settings (`Ctrl+,`). These edit the focused text control or selection. **Undo never invokes Pi checkpoint/undo, modifies source files, or rewinds the conversation.** Do not reimplement an editor history stack unnecessarily.                                  |
| **View** | Show/Hide Sidebar (`Ctrl+B`, checked); Zoom In/Out/Reset (`Ctrl++`, `Ctrl+-`, `Ctrl+0`); Full Screen (`F11`, checked); Theme submenu (Light/Dark/System); separator; Developer Tools using existing release-devtools support. Zoom changes actual webview/UI scale and is bounded/persisted. Do not reload the application to implement these actions.                             |
| **Help** | Check for Updates; Release Notes; Documentation; Open Logs Folder; Copy Diagnostics; About Leftleg. Use the shared update service. Show update availability/status here and offer Install and restart only when the update is ready. External URLs come from verified project/release configuration; no fabricated links. Missing destinations explain that they are unconfigured. |

Shortcut handling must not fire twice through both native and web listeners, send a composer message, override an extension dialog's text-editing shortcuts, or steal input during IME composition. When a menu opens, preserve the focused editable element/selection so Cut/Copy/Paste acts on the intended target. Use supported native editing commands where possible; dispatched synthetic Ctrl-key events are not an adequate clipboard/edit implementation.

For a custom menubar: semantic menubar/menuitem roles, accessible labels and expanded states, one open menu at a time, arrows to switch/navigate, Enter/Space activation, Escape to dismiss/restore focus, outside-click dismissal, disabled-item behavior, native-style Alt access keys, and pointer movement between already-open menus. Keep popups within the viewport and unclipped by scrolling/overflow. Verify at the minimum 720px window width, both themes, different DPI/zoom settings, and with the sidebar closed.

## 5. Implementation and acceptance

Deliver focused modules for update transport/state/scheduling, release configuration, guarded lifecycle, menu actions/presentation, About/build identity, and release workflow/documentation. Reuse existing Settings and notifications surfaces. Follow Tauri capability requirements, Svelte 5 syntax and repository command visibility rules.

Tests must establish:

1. Startup and timer checks never block app/Pi startup. Fake-clock tests cover six-hour cadence, sleep/reconnect, overlapping manual checks, cleanup and no duplicate notifications.
2. Missing feed, no update, newer version, wrong architecture, malformed manifest, offline/timeout, failed download and invalid signature produce correct recoverable states. Invalid or unsigned payloads cannot reach installation; include a real verification rejection, not just a mock that returns an error.
3. Automatic checks/downloads never install. Background activity, pending dialogs and unsaved drafts stop an unintended restart. Installation rechecks activity and preparation runs before Windows installer handoff.
4. A save/shutdown failure prevents installation and restores usable UI. Intentional shutdown doesn't become a crash banner; relaunch creates no duplicate Pi processes.
5. Menu mouse/keyboard actions work once, follow enabled/checked state, remain available with sidebar hidden, and restore focus. Edit Undo affects text only; Copy/Paste targets composer/settings inputs and selected chat text appropriately.
6. Version validation rejects tag/source disagreement. Published manifest matches the signed Windows artifact and configured architecture. About shows native/frontend identities and the real executable path.
7. In an isolated Windows installation, build signed A and B with temporary test keys, serve a controlled test feed, install A, discover/download/install B, relaunch and verify B plus preserved GUI preferences/Pi session references. Do not touch the real installed app, real signing identity, credentials or working sessions. If environment restrictions prevent this, report end-to-end verification as outstanding rather than claiming production readiness.

Run `npm run build`, `npm run check:rust`, and relevant `npm run test:rust`; package through `npm run tauri build` for installer/updater verification, never a bare cargo release exe. Validate workflow/config syntax and exact build identity. Do not create releases, push tags/commits, upload signing keys, alter GitHub settings, or install over my running app as a side effect of implementation.

Finish with: implemented behavior, checks passed, exact external release/signing prerequisites, and any unverified Windows lifecycle behavior. The result should make the next setup/publish action concrete and reviewable, without confusing a locally working prototype with an operational public update feed.
