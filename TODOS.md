# TODOS

AgentDeck backlog. Organized by component, then priority (P0 highest → P4). Completed at the bottom.

The core is proven: the end-to-end loop runs with a real agent (create → worktree → agent runs → prose question → reply via daemon → `claude --resume` → done → artifact). What's left is execution, not open risk.

## Dashboard / UI

- **`resuming` state visual (DT2)** — **Priority: P3**
  The daemon sets `status: "resuming"` on restart (A2). The dashboard renders it with a generic chip; give it a distinct, non-alarming indicator (spinner, not error-red) so a daemon restart doesn't look like a failure.

- **Cap / slice the diff in the drawer** — **Priority: P3**
  `openTask()` renders `df.diff` with no length cap (unlike events/pendingQuestion). A task with a large diff bloats the DOM. Slice it (e.g. first ~4KB) with a "…truncated" note. (Adversarial review F5.)

- **Density at scale (DT3)** — **Priority: P4**
  With 20-40 agents, the flat list gets long. Make the "Cruising" section a compact, collapsible strip; virtualize if needed. Keep the attention hierarchy (waiting/error pinned).

## Agent supervisor / core

- **Session-resume hardening (A2)** — **Priority: P3**
  On daemon restart, `claude --resume <sessionId>` reattaches, but only `sessionId` is persisted. Confirm cwd/worktree, pending question, and phase survive a real restart mid-run; persist whatever's missing.

- **Make daemon boot idempotent under `bun --watch` hot-reload** — **Priority: P3**
  `bun run dev` (`bun --watch`) re-execs `daemon.ts`'s top-level on every source change, which re-runs the A2 resume loop and spawns a second `claude --resume <session>` while the prior child (orphaned in the old module instance) is still alive — the one-live-child guard lives in the in-memory `running` map, which the reload resets. Pre-existing for `.ts` edits; embedding `public/index.html` into the module graph (v0.1.3.0) newly triggers it on dashboard edits too. Dev-only (the compiled binary and `bun run daemon` don't `--watch`). Fix: gate daemon boot side-effects behind a `globalThis` sentinel so hot-reload re-execs are inert. (Adversarial review, 2026-07-20.)

- **Full agent survival across a daemon crash** — **Priority: P4**
  Today a daemon crash pauses agents until it resumes (Path A2-A). The V2 option: agents as detached processes that keep running while the daemon is down, reconnecting to the stream on restart. Only worth it if daemon crashes become a real problem.

## Security / hardening

- **Shared-secret token on the hook endpoint (A3 / T5)** — **Priority: P3**
  `/hooks/notification` is unauthenticated. Localhost-bound so low risk today, but if hooks get enabled/exposed, any local process could forge a `waiting`. Add a per-session token written into the settings file and checked in the handler. (Deferred with A3.)

- **Pin release-workflow actions to commit SHAs** — **Priority: P4**
  `.github/workflows/release.yml` runs three actions (`actions/checkout@v4`, `oven-sh/setup-bun@v2`, `softprops/action-gh-release@v2`) pinned to mutable major tags in a `contents: write` job. Supply-chain-hardened choice is a full commit SHA for each (add Dependabot to bump them). Major-tag pinning is fine for now; revisit if the repo gets more contributors. (Review finding, 2026-07-20.)

- **Operational isolation (per-agent ports / RAM)** — **Priority: P4**
  Agents share the box; a runaway agent can starve others (port 3000, RAM, npm cache). Add per-agent port ranges + a memory cap when real contention shows up. (Not security — mono-user; it's about agents not stepping on each other.)

## Distribution (OSS)

- **Make the repo public** — **Priority: P2**
  The release + binaries work, but the repo is private, so the README's anonymous `curl .../releases/latest/download/...` install URL 404s. `gh repo edit Corenthin-Buffard/AgentDeck --visibility public` unblocks distribution. README + LICENSE (MIT) are public-ready, the codebase is fully rebranded to AgentDeck (no `gorch` left), and no secrets are tracked. Deliberately deferred (2026-07-20).

## Notifications

- **Notification hook for a future interactive mode** — **Priority: P4**
  Validated (2026-07-20) as inert under headless `claude -p` — the `Notification` event doesn't fire. The wiring is kept opt-in (`AGENTDECK_HOOKS=true`) for a future interactive/SDK (`query()` + Channels) mode where it would fire. Revisit if/when the daemon drives agents via the SDK library instead of the CLI.

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
- **v0.1.3.0** (2026-07-20) — Distribution pipeline (T8): single self-contained binary (`bun --compile` with the dashboard embedded), `release.yml` cross-compiles 3 targets on tag → GitHub Releases, `ci.yml` tests + compiles all targets on PR, README install section. All 3 targets verified to cross-compile; binary boots standalone from a foreign cwd.
- **v0.1.3.1** (2026-07-20) — Demo GIF in the README (`docs/demo.gif`): the Master Inbox with agents cruising, one flipping to `waiting`, the reply drawer, and the task resuming — captured from the real dashboard over its live WebSocket. Completes T8.
- **v0.1.3.7** (2026-07-20) — P2 **browser e2e proven** with a real agent: click "New task" → daemon spawns `claude` → it asks in prose → dashboard flips to `waiting` (WebSocket) → reply in the drawer → `claude --resume` → done → artifact (`color.txt`=`blue`), verified 3× incl. a self-contained run. Committed a reproducible harness at `docs/e2e/`. Surfaced a P3: "Clean up" dead-ends on done tasks with artifacts (dirty worktree).
- **v0.1.3.8** (2026-07-20) — P2 **full gstack loop proven**: a real agent ran `/plan-eng-review` through the daemon — scope-gate `AskUserQuestion` → prose → `waiting` → answer → `claude --resume` → the complete four-section eng review. This run exposed a detection bug (a long skill turn that ends on a decision brief was mis-marked `done`, stranding the agent); fixed `looksLikeQuestion` with a structural decision-brief check + tail-display of the question, hardened over two adversarial rounds (19 `detect.ts` tests).
- **v0.1.3.9** (2026-07-21) — P3 **"Clean up" dead-end fixed**: `cleanupWorktree` gained `safe`/`commit`/`force` modes so a done task's dirty worktree isn't a dead-end — commit preserves the agent's work on the branch, force discards. Hardened over two adversarial rounds (kill the live agent before a destructive cleanup; deterministic commit identity; structured `dirty` flag; guarded dashboard fetches). 5 `git.ts` integration tests.
- **A1** — proven: gstack skill runs headless, asks in prose, `resume` continues.
- **A1b** — proven: gstack runs headless with `--dangerously-skip-permissions`; the launch config is the key.
