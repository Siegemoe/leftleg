# Claude — start here

Project instructions live in **[AGENTS.md](AGENTS.md)** — read it first. It
covers the architecture summary, repo layout, build gates (`npm run build`,
`npm run check:rust` / `test:rust`), Svelte 5 + Tauri 2 rules, and the
`MAJOR.FEATURE.FIX` versioning policy.

Other docs to consult when relevant:

- `docs/ARCHITECTURE.md` — deep dive beyond AGENTS.md's summary
- `docs/RELEASE.md` — the per-release checklist (tag → draft → publish)
- `docs/AUDIT-2026-09-17.md` — latest hardening audit, accepted risks,
  verification loop record
- `docs/GAP-ANALYSIS.md` + `docs/ROADMAP.md` — what's next
- `CONTRIBUTING.md` / `SECURITY.md` — contribution and security policy

Non-negotiables (details in AGENTS.md): the frontend gate must stay at
0 errors / 0 warnings with tests passing; errors are never silent; pi owns
agent state — Leftleg only owns GUI state.
