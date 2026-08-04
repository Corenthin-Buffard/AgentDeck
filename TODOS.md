# TODOS

AgentDeck backlog. Organized by component, then priority (P0 highest → P4). Completed at the bottom.

The core is proven: the end-to-end loop runs with a real agent (create → worktree → agent runs → prose question → reply via daemon → `claude --resume` → done → artifact). What's left is execution, not open risk.

## Dashboard / UI

- **`resuming` state visual (DT2)** — **Priority: P3**
  The daemon sets `status: "resuming"` on restart (A2). The dashboard renders it with a generic chip; give it a distinct, non-alarming indicator (spinner, not error-red) so a daemon restart doesn't look like a failure. Partially addressed in v0.2.3.0: the CONNECTION indicator now has three distinct states (live / reconnecting in amber / unreachable in red), so a restart no longer reads as a failure. The per-task `resuming` chip is still generic — that half remains open.

- **Escape the remaining `openTask` interpolations** — **Priority: P4**
  `openTask()` interpolates `${t.phase}`, `${t.status}`, and `${id}` into the drawer HTML without `esc()`. Low risk today (all daemon-generated: fixed status/phase enums, `id` = `t_`+uuid — not user input), so it's defense-in-depth, not a live hole. Wrap them in `esc()` for consistency with the rest of the render. (Adversarial review, 2026-07-21.)

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

- **DNS-rebinding: gate every route on an allowed `Host`** — **Priority: P1**
  A hostile page whose domain resolves to `127.0.0.1` reaches the daemon with `Host: evil.com`, and reads are ungated by design, so `GET /api/tasks` hands it the whole board (titles, prompts, branches, errors, pending questions). Verified against a running daemon: `curl -H 'Host: evil.com' /api/tasks` → `200` with a body. The `/ws` Origin check added in v0.2.3.0 does NOT close this — it compares `Origin` against `url.host`, which Bun derives from the same attacker-controlled `Host` header, so the two validate each other. Fix: reject any request whose `Host` isn't an expected value (`127.0.0.1:<port>`, `localhost:<port>`, or an explicit allowlist for the reverse-proxy deployment) before routing, covering `/`, `/api/*` and `/ws`. Deliberately deferred from v0.2.3.0: it predates that branch and changes the "reads stay open on localhost" contract, which deserves its own PR. Surfaced by Codex during pre-landing review.

- **Pin release-workflow actions to commit SHAs** — **Priority: P4**
  `.github/workflows/release.yml` runs three actions (`actions/checkout@v4`, `oven-sh/setup-bun@v2`, `softprops/action-gh-release@v2`) pinned to mutable major tags in a `contents: write` job. Supply-chain-hardened choice is a full commit SHA for each (add Dependabot to bump them). Major-tag pinning is fine for now; revisit if the repo gets more contributors. (Review finding, 2026-07-20.)

- **Operational isolation (per-agent ports / RAM)** — **Priority: P4**
  Agents share the box; a runaway agent can starve others (port 3000, RAM, npm cache). Add per-agent port ranges + a memory cap when real contention shows up. (Not security — mono-user; it's about agents not stepping on each other.)

- **Race-safe upload write (fd-based) to close the residual TOCTOU** — **Priority: P4**
  The `/api/upload` containment check is realpath-then-pathname-write, so a local actor who holds the dashboard token AND can write `<repo>/.gstack` could, in principle, win the race between `realpathSync(root)` and `Bun.write`/`renameSync` by swapping a path component to a symlink after the check passes — redirecting the write. Pre-existing (v0.2.0.0), unchanged by the exact-dir hardening; the realistic static attack is closed. Fully closing it needs fd-based I/O (`open` the parent with `O_NOFOLLOW|O_DIRECTORY`, then `openat`/write relative to the fd) so the checked handle and the written handle are the same — not cleanly exposed by Bun stdlib today. Also minor: `mkdirSync(root)` runs before the check, so a pre-placed symlinked component can create an empty out-of-root dir before the 400. (Codex review, 2026-07-22.)

- **Split hook vs dashboard token is done; consider constant-time token compare** — **Priority: P4**
  The write gates compare the per-session token with `!==` (`server.ts`). For a 128-bit random secret on localhost a timing side-channel isn't realistically exploitable, but `crypto.timingSafeEqual` over equal-length buffers is a cheap belt-and-suspenders if the daemon is ever exposed beyond localhost. (Review finding, 2026-07-21.)

## Distribution (OSS)

- **Make the repo public** — **Priority: P2**
  The release pipeline + binaries are ready; flipping visibility to public (`gh repo edit Corenthin-Buffard/AgentDeck --visibility public`) unblocks the README's anonymous `curl .../releases/latest/download/...` install URL. README + LICENSE (MIT) are public-ready, the codebase is fully rebranded to AgentDeck, and no secrets are tracked in the tree or history.

## Notifications

- **Notification hook for a future interactive mode** — **Priority: P4**
  Validated (2026-07-20) as inert under headless `claude -p` — the `Notification` event doesn't fire. The wiring is kept opt-in (`AGENTDECK_HOOKS=true`) for a future interactive/SDK (`query()` + Channels) mode where it would fire. Revisit if/when the daemon drives agents via the SDK library instead of the CLI.

- **Discord provider + public auth/TLS** — **Priority: P4**
  Slack + Telegram ship (notification-only). Discord is stubbed. Public exposure (reverse proxy + auth/TLS) is deferred to V2 — localhost + SSH tunnel covers self-host today.

## Design system

- ~~**Formalize DESIGN.md (DT5)**~~ — **DONE** (2026-08-04)
  `DESIGN.md` ships at the repo root: tokens with their roles, the three color rules, the mono-as-identity decision, the two-row header invariants, interaction states, and the a11y floors. Written after the design review that found the approved brand lockup had been dropped during implementation — the failure mode DT5 existed to prevent.

- **Reply drawer renders AskUserQuestion payloads** — **Priority: P3**
  The drawer takes free text. When an agent's question is a gstack decision brief (options, recommendation, multi-select), the dashboard shows it as prose and the user retypes a letter. Rendering the structured payload would make the human-in-loop moment a first-class UI instead of a text box. (Design review 2026-07-19; density at scale is already tracked under Dashboard / UI.)

## Completed

- **v0.2.2.0** (2026-07-22) — **Auto-clean merged tasks (opt-in).** `AGENTDECK_AUTO_CLEAN_MERGED=true` → a periodic sweep (30s after boot, then every 5 min, non-overlap guarded) drops a `done` task's worktree + branch + dashboard row once its branch is proven merged. Merge proof is gh-ONLY (a merged PR `--head <branch> --base <base>` whose head SHA == the local tip → squash-safe); the `git --is-ancestor` fallback was dropped in review (couldn't distinguish a merged branch from a zero-commit one). Detection returns the proven SHA; the branch delete is an atomic compare-and-swap (`git update-ref -d <ref> <sha>`) so a commit landing after the proof is never force-deleted. New `"merged"` cleanup mode refuses a dirty/unreadable worktree; bounded `gh` (SIGKILL + hard timeout). `done` only (never a paused/queued task). Cross-model review (Claude + Codex) caught the merge-proof TOCTOU, the zero-commit fallback data loss, the missing PR-base filter, and the sweep-wedging hang — all fixed. `test/cleanup.test.ts` (DI orchestration) + `test/git.test.ts` CAS/fail-safe cases (86 tests).
- **v0.2.1.0** (2026-07-22) — **Plan-review tracking on the dashboard.** Each task card shows which of the three gstack plan reviews (CEO/Design/Eng) its branch has been through, as monochrome marks under the plan segment (○/✓/⚠, `*`=stale), Eng emphasized. The daemon auto-detects by reading the branch's `*-reviews.jsonl` via `gstack-review-read` in the task worktree, at each turn-end and on (re)attach — bounded (4s timeout+kill, in-flight guard) and safe (writes only on a clean/complete read, so a killed reader never clobbers good marks). Additive `plan_reviews` DB column (independent migration). Cross-model pre-landing review (Claude + Codex) caught the write-on-partial-read clobber, the short-SHA staleness false-positive, and marker-parsing robustness; all fixed before merge. New `test/plan-reviews.test.ts` + `test/db.test.ts` combos (72 tests).
- **v0.2.0.2** (2026-07-22) — **Upload containment pinned to the exact intended dir.** The `/api/upload` check accepted any dir under the repo and not `.git/`, so a pre-placed symlink at `<repo>/.gstack/browse-states` → `src/` still passed. Now it requires `realpathSync(root)` to EQUAL `realpath(trusted base)+literal subpath`, rejecting ANY symlinked component (out-of-repo, `.git/`, within-repo). Test covers the `→ src/` case. Codex flagged the residual pathname-write TOCTOU → tracked P4 (fd-based write).
- **v0.2.0.1** (2026-07-22) — **QA cookies reach the agent.** `/qa` confirmed the v0.2.0.0 cookie flow didn't deliver: `$B state load qa` resolves `.gstack/browse-states/` via git-toplevel (the worktree root, which carries no `.gstack/`), so a state uploaded to the main repo was invisible (`State not found`). `createWorktree` now symlinks the worktree's `.gstack/browse-states` to the project repo's shared dir (proven end-to-end: `State loaded`), with an absolute target and `.gstack/` in each managed repo's local `info/exclude` so the untracked symlink never dirties the repo or gets committed by a cleanup. Codex adversarial caught the dirtiness/commit gap before ship. Surfaced a P3 (tighten upload containment to the intended dir).
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
- **v0.1.3.10** (2026-07-21) — P3 **drawer diff capped** at 4000 chars (+ "…truncated" note) so a task touching many files can't bloat the drawer DOM; `esc()` still wraps the sliced string. Surfaced a P4 (escape the remaining `openTask` interpolations).
- **v0.1.3.11** (2026-07-21) — P3 **hook endpoints authenticated** (A3/T5): a per-session `hookToken` in the hook URL (`?token=`), settings file written `0600`, both `/hooks/*` POSTs 403 without the matching secret. Hardened over two adversarial rounds (empty-token-disables-gate footgun via `??`→`||`; write→chmod TOCTOU via `rmSync` first).
- **A1** — proven: gstack skill runs headless, asks in prose, `resume` continues.
- **A1b** — proven: gstack runs headless with `--dangerously-skip-permissions`; the launch config is the key.
