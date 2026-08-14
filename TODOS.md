# TODOS

AgentDeck backlog. Organized by component, then priority (P0 highest → P4). Completed at the bottom.

The core is proven: the end-to-end loop runs with a real agent (create → worktree → agent runs → prose question → reply via daemon → `claude --resume` → done → artifact). What's left is execution, not open risk.

## Dashboard / UI

- **`resuming` state visual (DT2)** — **Priority: P3**
  The daemon sets `status: "resuming"` on restart (A2). The dashboard renders it with a generic chip; give it a distinct, non-alarming indicator (spinner, not error-red) so a daemon restart doesn't look like a failure. Partially addressed in v0.2.3.0: the CONNECTION indicator now has three distinct states (live / reconnecting in amber / unreachable in red), so a restart no longer reads as a failure. The per-task `resuming` chip is still generic — that half remains open.

- **Density at scale (DT3)** — **Priority: P4**
  With 20-40 agents, the flat list gets long. Make the "Cruising" section a compact, collapsible strip; virtualize if needed. Keep the attention hierarchy (waiting/error pinned).

## Agent supervisor / core

- **Session ids don't survive a change of `HOME`** — **Priority: P3**
  Claude Code stores transcripts under `$HOME/.claude/projects/<encoded-cwd>`. The DB persists a `sessionId` as if it were portable; it isn't. Move the daemon to another account (or move the worktrees), and every stored `sessionId` becomes unresolvable — `claude --resume` finds nothing, and A2 durability loses those tasks **silently**, because the daemon can't even attribute the failure. Observed 2026-08-12: `/root/.claude/projects/-root--agentdeck-worktrees-t-703ad468` was orphaned by the migration to a service account. The README's migration section works around it by requiring a drain first. Open question: should the daemon detect an unresolvable `sessionId` and say so, instead of failing without explanation?

- **Per-task WebSocket deltas** — **Priority: P4**
  `broadcast()` (`src/server.ts`) serialises EVERY task on every update: a `SELECT *`, a
  `JSON.parse` per row, a `JSON.stringify` of the whole board, then a send to each open browser. So
  board cost scales with the number of tasks on screen — the same wall the DT3 density item runs
  into at 20-40 agents. The v0.2.5 work fixed the *frequency* (liveness coalescing, one write per
  250ms per task) because that was the amplification the pipeline introduced; deltas are the
  structural answer for board *size*. Send the changed task rather than the whole board. Depends on
  the coalescing landing first, so the two effects can be measured apart. (Eng review, 2026-08-12.)

- **Merge-time versioning** — **Priority: P3**
  The pipeline's `/ship` step deliberately tells the agent NOT to bump `VERSION` or edit
  `CHANGELOG.md`: agents work in sibling worktrees, so the collision is a *merge* conflict when the
  second PR lands, and no lock on ship-entry can prevent it. That removes the conflict but hands the
  bump to a human on every PR — invisible debt that compounds as agent count rises. `src/cleanup.ts`
  (v0.2.2.0) already proves a merged PR via `gh` with a head-SHA match, so the detection half exists;
  what is missing is the bump itself and a rule for several PRs landing together. Depends on the
  step-6 wording shipping. (Eng review, 2026-08-12.)

- **Queued tasks display as `running`** — **Priority: P3**
  `src/tasks.ts:24` sets `status: "running"` at creation, before any process exists. A task waiting behind `AGENTDECK_MAX_AGENTS` therefore shows on the board as live with no agent attached, so the running pill overstates what is actually executing. v0.2.4.1 fixed the *behavioural* half of this (a queued task can now be cancelled, and answering one no longer double-spawns), but not the display. Wants a real `queued` status through `Status`, the DB, the board sections and the pills. (Eng review, 2026-08-12.)

- **Session-resume hardening (A2)** — **Priority: P3**
  On daemon restart, `claude --resume <sessionId>` reattaches, but only `sessionId` is persisted. Confirm cwd/worktree, pending question, and phase survive a real restart mid-run; persist whatever's missing.

- **Make daemon boot idempotent under `bun --watch` hot-reload** — **Priority: P3**
  `bun run dev` (`bun --watch`) re-execs `daemon.ts`'s top-level on every source change, which re-runs the A2 resume loop and spawns a second `claude --resume <session>` while the prior child (orphaned in the old module instance) is still alive — the one-live-child guard lives in the in-memory `running` map, which the reload resets. Pre-existing for `.ts` edits; embedding `public/index.html` into the module graph (v0.1.3.0) newly triggers it on dashboard edits too. Dev-only (the compiled binary and `bun run daemon` don't `--watch`). Fix: gate daemon boot side-effects behind a `globalThis` sentinel so hot-reload re-execs are inert. (Adversarial review, 2026-07-20.)

- **Full agent survival across a daemon crash** — **Priority: P4**
  Today a daemon crash pauses agents until it resumes (Path A2-A). The V2 option: agents as detached processes that keep running while the daemon is down, reconnecting to the stream on restart. Only worth it if daemon crashes become a real problem.

## Security / hardening

- **`retire()` can hang a task forever, and never verifies the kill** — **Priority: P2**
  `src/agent.ts:201-215` SIGTERMs an agent child, sets a SIGKILL timer, and resolves on `close`. It never checks whether the process actually died, and — worse than the preview supervisor's equivalent, which was fixed — if the child survives SIGKILL or `close` never fires, the promise **never settles**. `killExisting` then never resolves, `scheduleAfterExit` (`src/agent.ts:249`) never respawns, and the task stalls silently with no notice and no error. `src/proc.ts` now has `killAndWait()`, which SIGTERMs, escalates, and verifies with `groupAlive()`; `retire` should use it. Pre-existing, surfaced by the preview branch's adversarial review (2026-08-14) but deliberately not fixed there — it is on the launch path for every agent and deserves its own change.

- **`killExisting` is not awaited in `removeTask`** — **Priority: P2**
  `src/tasks.ts` awaits `stopPreview` before `cleanupWorktree` but calls `killExisting(id)` fire-and-forget on the line above, so `removeTask(id, "force")` can run `git worktree remove --force` while `claude` is still live with that directory as its cwd. The comment directly above it ("so we don't orphan the child … or race its writes") is not honoured by the line beneath. Depends on the `retire()` item above, since awaiting a promise that can never settle is worse than not awaiting it. (Adversarial review, 2026-08-14.)

- **Drawer functions clobber whatever drawer is open after an await** — **Priority: P3**
  `openPreview` checks a staleness token (`pvOpenSeq`) before touching the DOM; nothing else does. `openTask` (`public/index.html`) awaits TWO fetches — one of them `/diff`, which is three git calls — then calls `showDrawer` unconditionally, so a slow diff overwrites a reply the operator has since started typing. Same shape, unconditional `closeDrawer()` after an await, in `sendAnswer`, `stop`, `del` and the upload handler. The token exists and is bumped correctly; these five callers simply never read it. (Adversarial review, 2026-08-14.)

- **No `process.on("unhandledRejection")` guard** — **Priority: P3**
  An unhandled rejection exits Bun with code 1, which for this daemon orphans every running agent. That class is currently closed one call site at a time via `fireAndForget()`; a three-line handler in `src/daemon.ts` would close it permanently and turn every future `void somePromise()` into a logged warning instead of an outage. Worth doing precisely because the per-site approach has already been got wrong once. (Adversarial review, 2026-08-14.)

- **A preview record with an unreadable starttime nags forever** — **Priority: P4**
  `reapOrphans` keeps any record whose identity it cannot confirm so the next boot retries, and warns each time. There is no age cap and no boot counter, so a record whose pid was recycled onto something unrelated years ago is still kept and still warned about, with no path to resolution. Wants a boot count or a timestamp after which the record is dropped with a final notice. (Adversarial review, 2026-08-14.)

- **Pin release-workflow actions to commit SHAs** — **Priority: P4**
  `.github/workflows/release.yml` runs three actions (`actions/checkout@v4`, `oven-sh/setup-bun@v2`, `softprops/action-gh-release@v2`) pinned to mutable major tags in a `contents: write` job. Supply-chain-hardened choice is a full commit SHA for each (add Dependabot to bump them). Major-tag pinning is fine for now; revisit if the repo gets more contributors. (Review finding, 2026-07-20.)

- **Operational isolation (per-agent ports / RAM)** — **Priority: P4**
  Agents share the box; a runaway agent can starve others (port 3000, RAM, npm cache). Add per-agent port ranges + a memory cap when real contention shows up. (Not security — mono-user; it's about agents not stepping on each other.)
  **Partly addressed in the preview work (v0.2.6.0):** previews take ports from an explicit pool (`AGENTDECK_PREVIEW_PORTS`) and run under a `systemd-run --scope -p MemoryMax=` ceiling when one can be created, so *that* consumer is bounded. **AGENTS themselves are still unbounded** — nothing stops an agent's own `npm run dev` grabbing port 3000 or eating the box, and `src/preview.ts:pickPort` documents that a 1-5s window between probe and bind is exactly where an agent can win the race. The remaining work is the agent half. Note the memory ceiling degrades to a warn notice where `systemd-run --user --scope` is unavailable (no user session bus, containers), so it is not a guarantee.

- **Server-side quiescence enforcement for previews** — **Priority: P3**
  The "never preview a worktree a running agent is rewriting" rule is enforced only in the dashboard (`previewBtn`/`previewSection` in `public/index.html`). `POST /api/tasks/:id/preview` accepts any status, so a stale browser tab or a `curl` reintroduces exactly the failure the rule exists to prevent: a file-watcher pointed at a worktree being rewritten, showing rebuild storms and half-finished builds that read as bad agent work. Token-gated, so it is not an external hole — it is two client entry points and a server that disagree about what the API permits. Fix: check the task's status in the POST handler and 409 with the same wording the disabled button uses. (Adversarial review, 2026-08-14.)

- **Sandbox what a preview actually executes** — **Priority: P3**
  `src/preview.ts`'s header is now honest that operator-authored commands are not a sandbox: the command is `npm install` / `npm run dev`, and both execute agent-authored code (lifecycle scripts, agent-chosen dependencies, `scripts.dev` itself) as the daemon uid with the daemon's full environment. Only the entry point is operator-authored. Incremental risk today is ~zero because the agent already ran as that uid with `--dangerously-skip-permissions` — this matters the moment `scripts/setup-agent-user.sh`'s uid-separation direction is taken further, at which point the preview path would quietly bypass it. Options, cheapest first: `--ignore-scripts` on install, a distinct uid for preview children, or a bwrap/namespace. (Adversarial review, 2026-08-14.)

- **`previews.json` is read without `O_NOFOLLOW`, and its records are only shape-validated** — **Priority: P4**
  The write path is hardened (`O_NOFOLLOW`, 0600) but the read in `reapOrphans` is not, and the file lives in a data dir the agent and the previewed dev server both own. The starttime match defends against pid RECYCLING, not against FORGERY: the same uid can read any `/proc/<pid>/stat` and supply a matching starttime, so it fully controls which process groups the daemon SIGTERMs at boot. Inert while agents share the daemon's uid (they could just call `kill`), and it becomes a real primitive under uid separation — same trigger as the item above. (Adversarial review, 2026-08-14.)

- **Race-safe upload write (fd-based) to close the residual TOCTOU** — **Priority: P4**
  The `/api/upload` containment check is realpath-then-pathname-write, so a local actor who holds the dashboard token AND can write `<repo>/.gstack` could, in principle, win the race between `realpathSync(root)` and `Bun.write`/`renameSync` by swapping a path component to a symlink after the check passes — redirecting the write. Pre-existing (v0.2.0.0), unchanged by the exact-dir hardening; the realistic static attack is closed. Fully closing it needs fd-based I/O (`open` the parent with `O_NOFOLLOW|O_DIRECTORY`, then `openat`/write relative to the fd) so the checked handle and the written handle are the same — not cleanly exposed by Bun stdlib today. Also minor: `mkdirSync(root)` runs before the check, so a pre-placed symlinked component can create an empty out-of-root dir before the 400. (Codex review, 2026-07-22.)

- **Split hook vs dashboard token is done; consider constant-time token compare** — **Priority: P4**
  The write gates compare the per-session token with `!==` (`server.ts`). For a 128-bit random secret on localhost a timing side-channel isn't realistically exploitable, but `crypto.timingSafeEqual` over equal-length buffers is a cheap belt-and-suspenders if the daemon is ever exposed beyond localhost. (Review finding, 2026-07-21.)

## Distribution (OSS)

- **Is `releases/latest` the right install channel for a project moving this fast?** — **Priority: P4**
  The release-drift guard (v0.2.5.3) narrows the window; it does not close it. This project shipped
  three versions in one day, so any release is stale within hours of being cut — the two-versions-behind
  binary that prompted the guard is just the extreme of a permanent condition. Three answers exist and
  none was chosen: make building from source the documented path, publish on every merge (rejected once
  already — it publishes binaries from any hasty merge), or accept that a release is a periodic snapshot
  and say so in the README instead of implying currency. Surfaced while closing the P2, 2026-08-13.

## Notifications

- **Notification hook for a future interactive mode** — **Priority: P4**
  Validated (2026-07-20) as inert under headless `claude -p` — the `Notification` event doesn't fire. The wiring is kept opt-in (`AGENTDECK_HOOKS=true`) for a future interactive/SDK (`query()` + Channels) mode where it would fire. Revisit if/when the daemon drives agents via the SDK library instead of the CLI.

- **Discord provider + public auth/TLS** — **Priority: P4**
  Slack + Telegram ship (notification-only). Discord is stubbed. Public exposure (reverse proxy + auth/TLS) is deferred to V2 — localhost + SSH tunnel covers self-host today.

## Design system

- ~~**Formalize DESIGN.md (DT5)**~~ — **DONE** (2026-08-04)
  `DESIGN.md` ships at the repo root: tokens with their roles, the three color rules, the mono-as-identity decision, the two-row header invariants, interaction states, and the a11y floors. Written after the design review that found the approved brand lockup had been dropped during implementation — the failure mode DT5 existed to prevent.

## Completed

- **v0.2.5.3** (2026-08-13) — **~~Make the repo public~~ — it already was, and verifying it found the real defect.** Measured: `visibility=PUBLIC`, and both anonymous URLs (`releases/latest/download/agentdeck-linux-x64`, the installer) answer 200. But the goal behind it was not met: `releases/latest` served **v0.2.4.1** while main was at 0.2.5.1 — the install URL handed out a binary two feature releases behind, paired with a runbook fetched from `main` describing features it did not have. Cutting a release is a manual step, forgotten twice, and nothing detected it. Now `scripts/check-release-current.sh` compares main's VERSION against the **published** release and turns main red once the last release is older than three days — not on every cycle, because a repo that is routinely red teaches everyone to ignore red. It never concludes from an unreachable API. The first cut measured the age of the VERSION bump and was wrong: every bump resets that clock, so a project shipping often would never accumulate age while the install URL stayed permanently behind. The installer now ships as a release asset, so script and binary come from one place. Four branches under test; the red one asserts the exact `git tag` command.

- **v0.2.5.2** (2026-08-13) — **An authentication failure is no longer reported as `done`.** The supervisor decided from `subtype` alone, and a real auth failure emits `{"subtype":"success","is_error":true,"terminal_reason":"api_error"}` — so a task whose agent never ran was marked done, with an empty worktree and a ✅ notification (observed: `t_c4d6e593`, 7.5s). A turn is now failed when `subtype` is not success OR `is_error` is true, and the agent's own words reach `task.error`. Two regression tests replay the captured event shape through a real subprocess, including the exit-1 that arrives too late to help; both fail without the fix.

- **v0.2.5.1** (2026-08-12) — **The install runbook stopped producing root installs**, which also closed the P2 above ("run agents as an unprivileged uid instead of relying on `IS_SANDBOX`") — *differently than planned*. The plan was to keep a root daemon and drop privileges per spawned agent; the answer was to not run the daemon as root at all. Measured on the way there, so nobody re-derives it: Bun's `node:child_process` **silently ignores** the `uid`/`gid` spawn options (asked for 65534, ran as 0, no error); `setpriv` does work, and a `feat/agent-user` branch implementing the drop was written and abandoned because it kept a root daemon and duplicated credentials, skills and permissions across two identities to solve what one unprivileged identity removes. Verified end to end: agent at uid 999, `--dangerously-skip-permissions` accepted, gstack resolving. New `scripts/setup-agent-user.sh` (+ `--check`, + a CI job that runs it for real), a runbook that branches on `uname -s` then `id -u`, and a migration section gated on a drain. `AGENTDECK_ALLOW_ROOT` survives unchanged as a last resort. Surfaced a P3: `sessionId`s don't survive a change of `HOME`.

- **v0.2.4.0** (2026-08-04) — **The reply drawer offers the agent's options.** A gstack decision brief reaches the dashboard as prose (headless Claude Code has no AskUserQuestion tool, so gstack renders briefs as text), and the operator had to read a wall of it and retype a letter. `parseDecisionBrief` in `src/detect.ts` now extracts the labeled options next to the existing detector, reusing its `BRIEF_MARKER` guard; the server attaches the result as a derived, never-persisted `brief` field. Clicking an option only PRE-FILLS the reply box — the brief stays on screen and nothing is sent until Send, because this parses prose and a mis-parse must be visible and free rather than dispatched to an agent running with skipped permissions. Refuses anything that isn't confidently a brief: no `Net:`/`Completeness:`/`D—` marker, fewer than two options, or a gap in the letters. 11 parser tests + 4 payload tests (107 total).

- **v0.2.3.1** (2026-08-04) — **DNS-rebinding gate on every route.** A hostile page whose domain resolves to `127.0.0.1` reached the daemon from the user's own browser with `Host: evil.com`; reads are ungated by design, so `GET /api/tasks` handed it the whole board. Verified before the fix: `curl -H 'Host: evil.com' /api/tasks` → `200` with a body. The v0.2.3.0 `/ws` Origin check could not close it — it compared `Origin` against `url.host`, and Bun derives `url.host` from the same attacker-controlled `Host`, so the two validated each other. Now every request is checked against a recognised `Host` **before routing**, reads included. Comparison is by NAME with the port ignored, because `ssh -L 9000:127.0.0.1:8787` makes the browser send `localhost:9000` while the daemon listens on 8787 — a `host:port` allowlist would have locked out the documented access path. `AGENTDECK_ALLOWED_HOSTS` covers the reverse-proxy case; binding off-loopback without it fails closed and warns at boot. Surfaced by Codex during the v0.2.3.0 pre-landing review.

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
