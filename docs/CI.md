# Continuous integration

Leftleg uses one stable required check, `Required quality gate`, backed by
independent frontend, real-Pi-contract, and Rust test jobs plus the formatting,
lint, and declared-minimum hygiene jobs. Only coverage reporting is advisory.

## Local commands

Use Node 22 (`.nvmrc`) and the Rust toolchain pinned in
`rust-toolchain.toml`. Install Pi 0.85.1 globally before running the real RPC
integration test.

| Command                     | Purpose                                                                                   | Current status                    |
| --------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| `npm run build:web`         | Svelte checks, tests that do not spawn Pi, production web build                           | Required and green                |
| `npm run test:integration`  | Five tests against a real isolated `pi --mode rpc` process                                | Required and green                |
| `npm run test:rust`         | Native unit and integration tests with the lockfile enforced                              | Required and green                |
| `npm run verify:functional` | Complete local functional gate                                                            | Required and green                |
| `npm run format:check`      | Prettier check for frontend, companion, config, and documentation files                   | Required (`Frontend hygiene`)     |
| `npm run lint`              | ESLint recommended rules plus typed promise checks at the application TypeScript boundary | Required (`Frontend hygiene`)     |
| `npm run format:rust:check` | Rustfmt check                                                                             | Required (`Rust hygiene`)         |
| `npm run lint:rust`         | Clippy for all targets and features with warnings denied                                  | Required (`Rust hygiene`)         |
| `npm run test:coverage`     | Vitest V8 coverage report; no arbitrary percentage threshold                              | Reporting only                    |
| `npm run verify`            | All frontend and Rust hygiene plus functional checks                                      | Full local battery; green locally |

`npm run build` remains the frontend gate required by `AGENTS.md`; it includes
all 315 tests and therefore needs Pi on `PATH`. The split commands exist so CI
can identify a frontend regression separately from a real Pi compatibility
regression.

## GitHub checks

### Required jobs

- `Frontend`: Svelte checks, 310 isolated tests, and the Vite build.
- `Pi contract`: the five real-process companion tests against pinned Pi.
- `Rust tests`: native behavior on the pinned Rust compiler.
- `Frontend hygiene`: Prettier and ESLint.
- `Rust hygiene`: rustfmt and Clippy (warnings denied).
- `Declared Rust compatibility`: builds the locked graph with the `rust-version`
  declared in `src-tauri/Cargo.toml` (1.98.1).
- `Required quality gate`: stable aggregate result for the branch ruleset.
- `Dependency review`: rejects high or critical vulnerabilities introduced by
  dependency changes in pull requests.

Only the aggregate check needs to be named in the branch ruleset. The internal
jobs can then be reorganized without changing repository settings.

### Advisory jobs

- `Coverage report (advisory)`: uploads a 14-day HTML and JSON report on master
  pushes and the weekly schedule.

The initial report covers 59.5% of statements, 50.79% of branches, 48.46% of
functions, and 65.99% of lines. Treat this as a map and a ratchet point, not as
a claim that every covered line has a strong assertion.

Advisory checks allow the report-generation step to fail, then publish a
warning and job summary while leaving the job green. This keeps the pull
request signal readable without hiding the output. Do not add an advisory job
to the branch ruleset.

## Hygiene baseline (cleared 2026-09-19)

The pipeline was introduced with the hygiene and MSRV checks set to advisory
because the pre-existing tree carried debt. The baseline has since been cleared
and the three hygiene jobs promoted into `Required quality gate`. Each class
was fixed in its own commit; subjects are cited rather than SHAs because
rebase merges rewrite SHAs:

- Prettier and rustfmt baselines applied ("style: apply prettier baseline",
  "style: apply rustfmt baseline").
- Clippy diagnostics resolved with no `#[allow]` suppressions ("fix: clear
  clippy advisory baseline"); a follow-up resolved the prettier×eslint
  interactions the reflow created ("style: resolve prettier and eslint
  interaction after baseline").
- ESLint errors and Svelte structural warnings cleared ("fix: clear eslint
  and svelte advisory baseline"), including the CodeRabbit findings on this
  pipeline itself (start-screen update-lock rechecks, `FileReader` rejection
  handling, `KeyboardEvent.code` bindings, and the management-scope
  foreground recheck — "fix: CodeRabbit findings — update-lock guard, paste
  errors, layout keys, mgmt scope").
- The hosted-runner flake in
  `pimgr::tests::update_deadline_includes_inherited_pipes_after_parent_exit`
  was fixed ("fix: make inherited-pipe deadline test robust to hosted-runner
  slowness"): the production 300 ms deadline was firing correctly; the test's
  own 1 s outer bound left too little headroom, and it now uses a 30 s
  grandchild drain with a 10 s outer bound.
- The declared Rust minimum was raised to the tested compiler ("build: declare
  Rust 1.98.1 as the supported minimum"): the previously declared 1.77.2 was
  unreachable because the locked graph pulls quick-xml 0.42 (transitive of
  tauri), whose manifest requires the `edition2024` cargo feature that 1.77.2
  cannot parse.
- GitHub Dependabot reports `GHSA-wrw7-89jp-8q8g` in the transitive Rust
  `glib` dependency below 0.20.0. This GHSA is the GitHub mirror of
  `RUSTSEC-2024-0429`, already accepted in `.cargo/audit.toml` with the
  version-lock rationale — glib 0.18 is pinned by tauri 2.11.5 → muda/tao →
  gtk 0.18, and 0.20 is unreachable until the tauri/wry stack moves. Closure
  is the documentation cross-reference, not an upgrade. Dependabot update
  attempts for it are expected to keep failing; dismiss them.

Promotion ("ci: promote the hygiene and MSRV jobs into the required gate"):
removed `continue-on-error` from the hygiene/MSRV check steps, added the three
jobs to `quality-gate.needs` and its result check, and kept
`Required quality gate` as the stable branch-rule check.

## Dependency and security maintenance

Dependabot opens grouped weekly update pull requests for npm, Cargo, and GitHub
Actions. Actions remain pinned to full commit SHAs; Dependabot updates the pin.
The weekly dependency audit continues to run `npm audit` and pinned
`cargo-audit`. GitHub CodeQL default setup is managed in repository settings so
GitHub can maintain the language/build configuration.

The initial CodeQL scan on 2026-09-19 completed successfully and opened 105
findings for the existing default branch. This is a triage queue, not 105
confirmed vulnerabilities:

| Rule                                   | Severity | Findings |
| -------------------------------------- | -------- | -------: |
| Rust command-line injection            | Critical |        3 |
| Rust path injection                    | High     |       80 |
| JavaScript path injection              | High     |       19 |
| JavaScript file-system race            | High     |        1 |
| JavaScript file access to HTTP         | Medium   |        1 |
| JavaScript prototype-pollution utility | Medium   |        1 |

Most findings cluster in `src-tauri/src/sessions.rs` (69),
`companion/leftleg-settings/index.ts` (18), and `src-tauri/src/pi.rs` (9).
Review the three command-line findings first, then group path findings by
shared trust boundary so one validated helper can address a class of reports.
Mark a finding false positive only after documenting why its input is trusted
or constrained.

Triage completed 2026-09-19: full record in
`docs/CODEQL-TRIAGE-2026-09-19.md` (classes, per-alert dispositions, and the
three commands now gated). 99 alerts were dismissed with class justifications,
and the 6 accepted risks that stayed open were remediated in code the same
day — the `leftleg-media` fd race fixed, project-folder creation moved behind
a Rust-owned dialog, and the attachment read hardened (details in the triage
doc's evening-remediation section).

## Later layers

The next pipeline layer should add a small Windows Tauri WebDriver suite for
launch, prompt streaming, session/project switching, image enlargement,
settings persistence, and crash recovery. Add it only with real journeys and
diagnostic artifacts; an empty E2E scaffold would create confidence without
proof. Rust coverage and selective mutation testing can follow once the hygiene
baseline is green.
