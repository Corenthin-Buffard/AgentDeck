# TODOS

AgentDeck backlog. Organized by component, then priority (P0 highest → P4). Completed at the bottom.

The core is proven: the end-to-end loop runs with a real agent (create → worktree → agent runs → prose question → reply via daemon → `claude --resume` → done → artifact). What's left is execution, not open risk.

## Dashboard / UI

- **Real task creation from the browser** — **Priority: P2**
  The loop is proven via the API/driver. Exercise the actual UX: click "Nouvelle tâche" in the dashboard → real agent runs → waiting appears → reply in the drawer → resumes. Confirm the WebSocket + reply drawer flow end-to-end in a browser, not just curl.
  _Depends on: nothing (daemon + dashboard shipped)._

- **`resuming` state visual (DT2)** — **Priority: P3**
  The daemon sets `status: "resuming"` on restart (A2). The dashboard renders it with a generic chip; give it a distinct, non-alarming indicator (spinner, not error-red) so a daemon restart doesn't look like a failure.

- **Cap / slice the diff in the drawer** — **Priority: P3**
  `openTask()` renders `df.diff` with no length cap (unlike events/pendingQuestion). A task with a large diff bloats the DOM. Slice it (e.g. first ~4KB) with a "…truncated" note. (Adversarial review F5.)

- **Density at scale (DT3)** — **Priority: P4**
  With 20-40 agents, the flat list gets long. Make the "Roulent tout seuls" section a compact, collapsible strip; virtualize if needed. Keep the attention hierarchy (waiting/error pinned).

## Agent supervisor / core

- **Full gstack loop end-to-end** — **Priority: P2**
  The e2e proof used a plain prompt (create a file + ask). Prove a *gstack skill* runs the full cycle: agent runs e.g. `/spec` or `/plan-eng-review`, asks its question in prose, you answer from the dashboard, and it continues the gstack flow. (A1/A1b proved the mechanism; this proves the real workflow.)
  _Depends on: real VPS launch config (skills in scope + skip-permissions — already wired)._

- **Session-resume hardening (A2)** — **Priority: P3**
  On daemon restart, `claude --resume <sessionId>` reattaches, but only `sessionId` is persisted. Confirm cwd/worktree, pending question, and phase survive a real restart mid-run; persist whatever's missing.

- **Full agent survival across a daemon crash** — **Priority: P4**
  Today a daemon crash pauses agents until it resumes (Path A2-A). The V2 option: agents as detached processes that keep running while the daemon is down, reconnecting to the stream on restart. Only worth it if daemon crashes become a real problem.

## Security / hardening

- **Shared-secret token on the hook endpoint (A3 / T5)** — **Priority: P3**
  `/hooks/notification` is unauthenticated. Localhost-bound so low risk today, but if hooks get enabled/exposed, any local process could forge a `waiting`. Add a per-session token written into the settings file and checked in the handler. (Deferred with A3.)

- **Pin release-workflow actions to commit SHAs** — **Priority: P4**
  `.github/workflows/release.yml` runs the third-party `softprops/action-gh-release@v2` in a `contents: write` job, pinned to a major tag. Supply-chain-hardened choice is a full commit SHA (add Dependabot to bump it). Major-tag pinning is fine for now; revisit if the repo gets more contributors. (Review finding, 2026-07-20.)

- **Operational isolation (per-agent ports / RAM)** — **Priority: P4**
  Agents share the box; a runaway agent can starve others (port 3000, RAM, npm cache). Add per-agent port ranges + a memory cap when real contention shows up. (Not security — mono-user; it's about agents not stepping on each other.)

## Distribution (OSS)

- **Record the demo GIF (T8 remainder)** — **Priority: P2**
  The binary + CI release pipeline shipped (`bun run build` → self-contained `dist/agentdeck`; `.github/workflows/release.yml` cross-compiles linux x64/arm64 + darwin arm64 on tag and uploads to Releases; the frontend is embedded via `import … with { type: "text" }`). What's left is the manual asset: record N parallel agents on the board — one flips to `waiting`, a phone notification fires, you reply in the drawer, it resumes — save to `docs/demo.gif`, and uncomment the `<img>` in README. Distribution IS the product for an OSS repo (design-doc Premise 3).

## Notifications

- **Notification hook for a future interactive mode** — **Priority: P4**
  Validated (2026-07-20) as inert under headless `claude -p` — the `Notification` event doesn't fire. The wiring is kept opt-in (`GORCH_HOOKS=true`) for a future interactive/SDK (`query()` + Channels) mode where it would fire. Revisit if/when the daemon drives agents via the SDK library instead of the CLI.

- **Discord provider + public auth/TLS** — **Priority: P4**
  Slack + Telegram ship (notification-only). Discord is stubbed. Public exposure (reverse proxy + auth/TLS) is deferred to V2 — localhost + SSH tunnel covers self-host today.

## Design system

- **Formalize DESIGN.md (DT5)** — **Priority: P4**
  The Master Inbox mockup defined the tokens (colors, mono-identity type, attention hierarchy). Lift them into a `DESIGN.md` (or run `/design-consultation`) so future UI stays consistent.

## Completed

- **v0.1.0.0** (2026-07-19) — Daemon v0: worktree lifecycle, headless agent supervisor (Path A, prose + `claude --resume`), SQLite/WAL state, gstack phase mapping, Slack/Telegram notify, Master Inbox dashboard. A1 spike proving the prose+resume mechanic.
- **v0.1.1.0** (2026-07-19) — Reply-drawer polish, a11y (`aria-live`), pending-question preview, keyboard submit; extracted `looksLikeQuestion` to a pure module; 15 unit tests.
- **v0.1.2.0** (2026-07-20) — Opt-in Notification-hook wiring; hardened after review (one-live-child-per-task, opt-in default, guarded settings write).
- **v0.1.2.1** (2026-07-20) — Docs: recorded that the Notification hook does not fire headless (validated on a real run).
- **v0.1.2.2** (2026-07-20) — Fixed: untracked files show in the diff view; single-source the agent turn text (a review CRITICAL — a dropped restated question could have stranded an agent as `done`).
- **v0.1.3.0** (2026-07-20) — Distribution pipeline (T8): single self-contained binary (`bun --compile` with the dashboard embedded), `release.yml` cross-compiles 3 targets on tag → GitHub Releases, `ci.yml` tests + compiles all targets on PR, README install section. All 3 targets verified to cross-compile; binary boots standalone from a foreign cwd. GIF recording still open.
- **A1** — proven: gstack skill runs headless, asks in prose, `resume` continues.
- **A1b** — proven: gstack runs headless with `--dangerously-skip-permissions`; the launch config is the key.
