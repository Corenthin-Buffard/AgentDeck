# Changelog

## [0.2.6.0] - 2026-08-14

### Added
- **Preview: see the app an agent built, without SSHing in.** A task row now carries a
  **Preview** button. Click it and the daemon starts that task's dev server inside its own git
  worktree, on a port from a small pool, and hands you a link. Previously the only way to judge an
  agent's work was to read the diff or SSH in and start a dev server by hand.

  Configure it per project in `projects.json`:

  ```json
  { "id": "web", "path": "/srv/web",
    "install": "npm ci",
    "preview": "npm run dev -- --port {port} --host 127.0.0.1 --strictPort" }
  ```

  Then forward the pool alongside the dashboard — `ssh -L 8788:127.0.0.1:8788 …` — or add one to a
  session you already have open with `ssh -O forward`. A project without those two fields works
  exactly as before, minus the button.

  A fresh worktree has no `node_modules` (git carries tracked files only), so the daemon runs your
  `install` command first and the board shows **Installing…** while it does. Verified end to end
  against a real Vite app: fresh worktree → install → ready in seconds → the app at `/`, with HMR
  reconnecting and a live edit hot-reloading in the preview tab.

- **Previews run on their own port, deliberately.** The app an agent wrote is unreviewed code. On
  the dashboard's own origin its JavaScript could read the dashboard token out of the page and drive
  the API; on a separate port it cannot, while everything the app itself needs — its own fetches,
  storage, cookies, HMR — keeps working. Dev servers always bind loopback regardless of
  `AGENTDECK_HOST`, and the README documents the firewall rule that backs that up.

- **Previews stop themselves.** A hard lifetime cap (`AGENTDECK_PREVIEW_TTL_MS`, 4h, `0` disables),
  a memory ceiling per preview where systemd can provide one, and a health check that flips a dev
  server that died on its own to **failed** on the board rather than leaving a dead link.

- **New knobs:** `AGENTDECK_PREVIEW`, `AGENTDECK_PREVIEW_PORTS` (default `8788-8790`, and the pool
  size IS the concurrency limit), `AGENTDECK_PREVIEW_TTL_MS`, `AGENTDECK_PREVIEW_MEM_MAX`,
  `AGENTDECK_PREVIEW_READY_TIMEOUT_MS`, `AGENTDECK_PREVIEW_INSTALL_TIMEOUT_MS`.

### Fixed
- **Deleting a preview deleted the whole task.** `DELETE /api/tasks/<id>/preview` matched the
  task-deletion branch, which tested only the HTTP method and ignored the trailing path segment — so
  it removed the worktree, the branch and the row. Nothing had ever sent a DELETE to a task
  sub-resource before, so nothing caught it. A sub-resource must now opt in to DELETE explicitly.

- **Slow operations no longer report failure while succeeding.** Starting a preview and stopping one
  both answer immediately and report progress live, because the server closes any request that runs
  longer than its timeout — and a cold `npm install` is minutes. Previously the browser saw a socket
  error while the install carried on invisibly. Every git call is now bounded too, so a repo lock or
  a stale mount can no longer wedge a task deletion indefinitely.

- **A daemon restart no longer strands dev servers.** If the daemon is killed outright, the next
  boot finds the servers it left behind, shuts them down and frees their ports — and where it cannot
  confirm one is safe to signal, it says so and leaves it alone rather than risking an unrelated
  process.

- **Auto-clean will not delete a worktree you are looking at.** A task with a running preview is
  skipped by the merged-branch sweep, and deleting a task shuts its preview down first.

### Changed
- Process spawning, output capture and secret scrubbing moved into a shared module, so the agent
  supervisor and the preview supervisor use one implementation instead of two. No behaviour change.
- Disabled buttons are marked with a dashed border rather than by dimming their text, which had put
  four of the preview control's states below the contrast floor the design system requires.

## [0.2.5.3] - 2026-08-13

### Fixed
- **The install URL served a binary two feature releases behind.** `releases/latest` handed out
  **v0.2.4.1** while `main` was at 0.2.5.1 — no pipeline, no non-root work — paired with an installer
  the runbook fetched from `main`, describing features that binary did not have. Cutting a release is
  a manual `git tag`, it was forgotten for v0.2.5.0 and again for v0.2.5.1, and nothing detected it.

  Found while closing the "make the repo public" TODO, which turned out to be **already done**
  (`visibility=PUBLIC`, both anonymous URLs answering 200). The repo was public; what it published
  was stale.

### Added
- **`scripts/check-release-current.sh`** and a CI job that runs it on `main`. It compares main's
  VERSION against the **published release** — not merely against the existence of a tag, so a release
  build that failed is caught too — and fails only once the last release is older than three days.
  Not on every cycle: main is legitimately ahead between a merge and its tag, and a repo that is
  routinely red teaches everyone to ignore red. It never concludes from a non-answer either; a
  rate-limited or unreachable API reports that it cannot tell, because the alternative is sending the
  operator to tag a version that is already published.

  The first cut measured the age of the VERSION bump and was wrong: every bump resets that clock, so
  a project shipping several versions a day would never accumulate age while the install URL stayed
  permanently behind. It measures the age of the published release instead.

  The logic lives in a script rather than inline in the workflow because a `main`-only job cannot be
  exercised by any pull request — its four branches would have shipped having run nowhere. Same reason
  46f489f moved the agent launch command out of the spawn call. `test/release-current.test.ts` drives
  all four through the real subprocess, and the red one asserts the exact `git tag` command it prints.
- **The installer ships as a release asset.** The runbook curled `setup-agent-user.sh` from `main`
  while the binary came from `releases/latest` — two sources for one install, guaranteed to disagree
  the moment main moves. One URL now, from the same release as the daemon.

## [0.2.5.2] - 2026-08-13

### Fixed
- **An authentication failure was reported as `done`.** The agent produced one line — `Not logged in
  · Please run /login` — `claude -p` exited 1, and the board showed **done**: no error, an empty
  worktree, and a ✅ notification. Observed end to end on task `t_c4d6e593`, which "completed" in 7.5
  seconds having produced nothing.

  The supervisor decided from `subtype` alone. Captured from a real failure, the terminal event is:

  ```json
  {"type":"result","subtype":"success","is_error":true,
   "terminal_reason":"api_error","result":"Not logged in · Please run /login"}
  ```

  `subtype` says `success` on a turn that never ran. A clean turn carries `is_error:false` and
  `terminal_reason:"completed"`, so either of those discriminates and `subtype` does not. The
  non-zero exit arrives afterwards and is dropped, because by then the close handler finds a task
  that is already terminal — the ordering is why the exit code could never have saved it.

  Now a turn is failed when `subtype` is not success **or** `is_error` is true, and the agent's own
  words carry into `task.error`: `result: api_error: Not logged in · Please run /login` instead of a
  bare code. Pipeline tasks treat it as any other failed turn — bounded per-step retries, no advance,
  since a turn that never ran cannot have completed its step.

  This is the same family as the v0.2.4.1 root bug — an invisible failure — except it presented as
  **success**, which is strictly worse than the error it replaced. Two regression tests replay the
  captured shape (result first, then exit 1) through a real subprocess; both fail without the fix.

## [0.2.5.1] - 2026-08-12

### Fixed
- **The install runbook still produced the broken install it now detects.** v0.2.4.1 taught the
  daemon to recognise that it was running as root and explain itself. The README, meanwhile, kept
  installing as root and offering `AGENTDECK_ALLOW_ROOT` as one of two equal options — so anyone
  following it reproduced exactly the situation that produced the bug report, and the fastest way out
  of the red banner was the workaround rather than the fix. The README also contradicted itself:
  it called `User=` in the systemd unit "the supported configuration" while the runbook wrote a
  `systemd --user` unit, where `User=` is not a valid directive.

  The runbook now branches on `uname -s` and then `id -u`. Installing as yourself is unchanged.
  Installing as **root** creates a dedicated unprivileged service account and a system unit for it,
  and the install is not declared successful until a witness task actually runs in the target repo.
  `AGENTDECK_ALLOW_ROOT` is no longer offered there; it remains documented as a last resort for
  machines where no service account can be created, and its behaviour is unchanged.

### Changed
- **The runbook shrank to what a script cannot decide.** It was followed on a real machine and took
  nine round trips: wrong step order, `claude login` instead of `claude auth login`, a command
  missing its PATH, copied credentials that rot, a sign-in URL printed twice, root-owned directories
  under the service home, an unregistered deploy key, and a witness task marked `done` in 7.5 seconds
  having produced nothing. Each was patched into the prose as it happened.

  The diagnosis: three artifacts describe the same requirements and only one can lie. The script and
  `--check` are executed, so they are true by construction; the runbook is a narrative nobody runs.
  So the prose now keeps only the decisions — which account, which credentials, which repo, which key
  — and **every failing `--check` line prints the command that fixes it**. Installing gstack, bun,
  bunx, node and the binary left the text entirely: the tool asks for them and hands you the command.

### Added
- **`scripts/setup-agent-user.sh`** — the mechanical half of the root path: creates the account and
  its directories, writes `/etc/systemd/system/agentdeck.service`, reloads systemd. Idempotent, and
  deliberately does *not* enable or start the service, because credentials and repo access are human
  decisions that must come first. It is the single source of truth for the unit's contents; the
  README shows the invocation rather than a second copy that would drift.
- **`--check`**, an audit of what the *agent* needs — `claude`, its own Claude Code credentials,
  gstack, `git`, an authenticated `gh`, `bun`/`bunx`/`node` — resolved as the service user, on the
  service PATH. It exits 0 (ready), 2 (the daemon will run but a flagged part of the workflow will
  not, e.g. `/ship` without `gh`) or 1 (broken; don't start it). Checking with your own PATH is how
  an install gets certified and then fails on first contact.
- **A credentials check that asks Claude Code, instead of reading its credentials file.** `--check`
  now runs `claude auth status` as the service user and reads `loggedIn`. Copying
  `~/.claude/.credentials.json` to the service account is the obvious way to give it a session, and it
  rots: the OAuth refresh token rotates, so the copy works until your own session refreshes and then
  every agent fails at authentication. Measured — the copy was dead within hours, `--check` reported
  the file as present the whole time, and the daemon marked the failed task `done`. A file check
  cannot see that; the CLI's own verdict can. The runbook now leads with `claude auth login` under the
  service account and marks copying a stopgap.
- **A home-ownership check.** A service account that does not own its own `$HOME` is the quiet
  failure: the daemon only *reads* most of it, so every other line of `--check` stays green and the
  dashboard looks healthy, until an agent *writes*. Found the hard way on a hand-built install where
  `.config` was left root-owned — `gh auth login` died on `mkdir: permission denied` while nothing
  else complained. The check scans the whole top level of the home rather than the three directories
  the script happens to create, because any later `sudo mkdir` recreates the state.
- **A remote-reachability probe.** `--check` verified the agent could write the repo *locally* and
  never that it could reach it, so an install passed every line and then died on its first task with
  `Permission denied (publickey)`. It now runs `git ls-remote` as the service user with
  `BatchMode=yes` — not decoration: `--check` runs from a terminal, the daemon runs under systemd with
  none, and SSH's default is to ASK before trusting an unknown host, so without it the probe goes green
  where the daemon's push dies on `Host key verification failed`. Distinguishes an unregistered deploy
  key (and prints the `gh repo deploy-key add` line, repo slug derived from the remote URL) from an
  unseeded host key, a local path that isn't there, a timeout, and a repo with no remote at all.
- **`--check` runs unprivileged when you are the service account.** The root guard covered both modes,
  so a SELF-mode install — you installing for yourself — could not open the gate the runbook tells it
  to open. The guard moved to provisioning, where root is actually needed.
- **A warning when the agent's `gh` token is wider than its deploy key.** The device flow mints `repo`
  scope: write access to every repo the account owns, which quietly undoes the reason the deploy key
  was scoped to one. A warning, not a failure — a broad token works, it is only broader than intended.
- **A "when it breaks, start from the message" index** in the README: eight symptoms, each pointing at
  the step that explains it. Every row cost a round trip during the real install, because each message
  points somewhere other than its cause.
- **A CI job that runs the script for real**, twice, and asserts the generated unit parses
  (`systemd-analyze verify`) — plus a case asserting `--check` still *fails* on an unfinished
  install, so the gate can't silently become inert.
- **A migration section** for existing root installs, which opens with a required drain: Claude Code
  stores transcripts under `$HOME`, so changing the daemon's `HOME` makes every stored `sessionId`
  unresolvable and `claude --resume` loses those tasks silently.

### Changed
- `ROOT_BLOCKED_MESSAGE` now leads with the real fix and lists the workarounds after it, mildest
  first — an operator acting on a red banner acts on the first remedy they read, and for two
  releases that was the one keeping every agent at uid 0. A test asserts the order, not just the
  presence of each string.

## [0.2.5.0] - 2026-08-12

### Added
- **The daemon now drives the gstack pipeline instead of hoping the agent does.** Tick *Follow the
  gstack pipeline* on a new task and AgentDeck runs it as a sequence — `/spec` → `/autoplan` →
  implement → `/review` → `/qa` → `/ship` → `/canary` — one `claude -p` turn per step, advancing on
  success. `phase` stops being archaeology and becomes something the daemon knows, because it is
  what the daemon just asked for.

  The first design injected a preamble telling the agent to follow the sequence. The plan review's
  outside voice killed it, correctly: an instruction is unenforceable here. A turn ends when the
  model stops, and the supervisor reads a quiet `result` as `done` — so an agent that finished
  `/spec`, wrote a summary and stopped would have been marked complete for ever, half a pipeline in.

  Each step runs in a **fresh session**. Resuming would pile seven heavy skills into one context,
  which compacts, and a compacted agent that loses the thread simply ends its turn — which this
  daemon reads as success. Steps hand off through gstack's on-disk artifacts instead. That handoff
  is the design's central bet and the one thing only a real run can validate.

  A question does not advance the step: answering resumes that step's session. A turn that *failed*
  retries, bounded per step; a step that *ran* and reported it cannot proceed halts the task.

  `/ship` is told not to bump `VERSION` or edit `CHANGELOG.md`. Agents work in sibling worktrees, so
  there is no concurrent write — the collision is a *merge* conflict when the second PR lands, which
  no lock on ship-entry can prevent. Removing the per-task bump removes the conflict.

  Off by default (`AGENTDECK_PIPELINE`), so upgrading can never start opening PRs on its own. The
  step table is overridable at `<dataDir>/pipeline-steps.md`, read lazily so a bad file degrades to
  the built-in table with a dashboard notice rather than crash-looping the daemon.

### Fixed
- **The board had never once shown a gstack phase.** `src/agent.ts` read the skill name from
  `input.skill` on a `content_block_start` event, but the Anthropic streaming protocol starts every
  `tool_use` block with `input: {}` **by design** — the arguments follow as `input_json_delta`
  fragments. Confirmed against a real capture: `content_block_start` gives
  `{"name":"Skill","input":{}}`, and the name only materialises on the consolidated `assistant`
  message as `{"skill":"careful"}`. So `SKILL_PHASE` never fired in production, and every phase on
  every board came from the `Edit|Write` → `run` rule plus the terminal `done`. The CEO/Design/Eng
  glyphs were never affected — they come from the `gstack-review-read` subprocess.

  Also: an agent that types `/review` emits no `Skill` block at all, so the `SlashCommand` path is
  handled too; skill names are normalised; `/autoplan` joins the map; and `/canary` moves from `qa`
  to `ship`, because as `qa` it arrived after `/ship` and was swallowed by the forward-only merge.

- **A permanently-failing pipeline step respawned agents forever.** `retryStep` set its
  budget and then advanced through `killExisting`, which clears per-task state on every step
  transition — so each retry wiped its own bound. Caught by the first integration test that
  ever drove the state machine: nine spawns instead of three. The budget is now cleared where
  a task actually leaves the pipeline, not where it merely changes step.
- **One malformed event no longer strands a task.** Several stream-json events arrive in a
  single read, and a throw while handling one abandoned every remaining line in that chunk —
  including the `result` that decides whether the task advances. The task then sat in
  `running` until its child closed and was reported as "exited mid-run", which was a lie: the
  agent had finished fine, the supervisor dropped the event.
- **Any agent could hang every future daemon boot.** The step-table override is read from
  the data dir, and `worktreesDir` sits under it — so an agent could create a FIFO at that
  path from its own worktree. `open(2)` on a FIFO blocks forever and never throws, so a
  never-throws guarantee said nothing about it: the daemon stopped before binding a port,
  with no dashboard, no notice and no systemd restart, because the process stayed alive.
  The read now refuses anything that is not a small regular file, opens non-blocking, and
  never follows a symlink. Verified by booting the shipped binary with a FIFO planted at
  the path: it starts, serves, and says why.
- **Pausing a task did not pause it.** The stdout handler had no check that the child still
  owned the task, so a stopped pipeline task kept advancing — reproduced going from
  `stopped` to `done` on its own, two agent launches later. On the full table that path
  reaches `/ship`. The handler now applies the same ownership guard the terminal handlers
  already used.
- **A step index past the end of the table** (an operator shrinks `pipeline-steps.md` under a
  running task) now fails with the reason instead of parking the task in `running` with no
  process, no error and nothing to see — and it is caught where the realistic path actually
  reads it, so a task can no longer graduate having silently skipped `/ship` and `/canary`.
- **The plan segment went dark the moment `/spec` wrote a file.** Phase signals now carry
  authoritative-ness per skill. `mergePhase` was strictly forward-only, so the Edit `/spec` makes
  writing its own spec file pushed the bar to `run`, and every later plan-phase skill was rejected
  as a regression. A skill knows which phase it is in; an edit is only guessing.
  `investigate`/`design-review`/`browse` stay inferred, so debugging during `/ship` cannot drag the
  bar backwards.

### Changed
- The dashboard tells three pipeline states apart: driven, free-form (muted and dashed — not
  measuring, by choice), and *commanded but nothing happened* (amber, "pipeline did not run"). The
  third is deliberately **not** `status: "error"`: the code may be fine, what failed is that it went
  unreviewed, and overloading the loudest signal trains you to ignore it.
- The per-tool-call liveness write is coalesced to one per 250ms per task. Every tool call used to
  trigger a SQLite `UPDATE` plus a full-board re-serialisation; the pipeline makes that path roughly
  a hundredfold busier. Real transitions still broadcast immediately.

### Internal
- The step table is validated at BOOT, not on the first pipeline task, so a broken override is
  visible at startup rather than at first use; the resolved table is recorded once per task and
  shown in the drawer with the current step marked.
- Six integration tests drive the real supervisor against a fake `claude` over real pipes and
  exit codes: advance across steps in fresh sessions, the commanded skill credited while an
  ad-hoc one is not, `STEP BLOCKED` halting instead of continuing to ship, a question parking
  the task without advancing it, the retry bound, and a free-form task left alone.
- `argvFor()` and `spawnAgent()` make the launch command line a value tests can assert on. It was
  assembled inline at three call sites and checked by nothing — which is exactly how a flag missing
  from all three at once survived eight releases.
- `pipeline`, `step`, `step_skill_seen` and `pipeline_missed` columns. `pipeline` **backfills**
  rather than coalescing at read, unlike `project`/`plan_reviews`: it records a choice made at
  creation, and a task already three steps in must not change what it is doing because the operator
  edited an env var and restarted.
- 285 tests, up from 107 before this branch.

## [0.2.4.1] - 2026-08-12

### Fixed
- **A daemon running as root failed every task in milliseconds, and nothing said why.** Claude Code
  refuses `--dangerously-skip-permissions` under uid 0 — and that flag is the one AgentDeck depends
  on for gstack skills to resolve headlessly. So every task died at spawn with `agent exited (code 1)
  mid-run` and no further explanation: the agent's actual message went to journald via
  `stdio: [..., "inherit"]` and never reached the task. The worktree and branch were created
  correctly, which made it look like a mid-run crash rather than a launch that never happened.

  Three things change. The daemon now **detects root at boot** and says so — in the log, as a red
  banner on the dashboard, and as `ok: false` from the new `GET /api/health`. It **refuses to create
  tasks** while it knows they cannot run, instead of leaving a trail of dead worktrees. And it
  **captures the agent's stderr**, so `task.error` ends with the real cause rather than an exit code.

  If the daemon must run as root, `AGENTDECK_ALLOW_ROOT=true` passes `IS_SANDBOX=1` to agents, which
  lifts Claude Code's guard and keeps gstack working. It is opt-in on purpose: those agents run as
  root with permissions fully skipped, so the blast radius becomes the box rather than one worktree.
  `IS_SANDBOX` is also an undocumented Claude Code internal that a future release can remove — so a
  task that dies on the root refusal while the opt-in is set **retracts the banner** and says the
  escape hatch is gone. A banner that lies is worse than no banner.

- **A missing `claude` binary took down the whole daemon.** On ENOENT, Node fires `error` and never
  fires `exit`; there was no `error` handler, so the unhandled EventEmitter error killed the process
  — and with `Restart=on-failure` plus resume-on-boot, that is a crash loop, not one dead daemon. Now
  it marks that one task failed and names `AGENTDECK_CLAUDE_BIN`. The daemon also checks for the
  binary at boot, so the usual cause (a systemd unit's PATH is not your login shell's) is caught once
  rather than once per task.

- **Pausing a queued task didn't pause it, and answering one started two agents.** `killExisting`
  only ever looked at children that already existed, so a task waiting behind `AGENTDECK_MAX_AGENTS`
  was invisible to it: `stopTask` marked it stopped and it spawned anyway when a slot freed, and
  `answer()` scheduled a second launch beside the pending first — two `claude --resume` on one
  session, which is precisely what that function exists to prevent. The second registration also
  overwrote the first, so the daemon undercounted live agents (quietly exceeding the cap) and leaked
  a concurrency slot each time. Queued launches are now cancellable.

- **An OOM-killed agent reported `code null`.** The exit handler dropped the signal; it now reads
  `signal SIGKILL`. A task killed while `resuming` was stranded in that state for ever with no error
  text — the exact path taken by tasks resumed after a daemon restart.

- **`--version` and `--help`** are answered without booting anything. This needed a new entry module:
  `config.ts` does real I/O at import time (it creates the data dir and mints the dashboard token),
  so a flag check inside `daemon.ts` would already have written to disk before it ran.

- **A port clash** printed a raw Bun stack trace and skipped the auto-clean sweep. It now prints one
  line and exits 78, and the README's systemd unit pairs that with `RestartPreventExitStatus=78` so
  a config error stops cleanly instead of restart-looping against a port that will still be busy.

- **The install runbook reported success on a root VPS where every task dies.** It verified with
  `systemctl is-active` plus a grep for the page title — both of which pass on a completely broken
  install. It now checks `id -u` before writing the env file, and verifies with `/api/health`.

- **The release workflow was building the wrong entry point.** Moving argv handling into
  `src/main.ts` updated `package.json` and CI, but `release.yml` kept compiling `src/daemon.ts` — so
  CI stayed green while every *published binary* would have shipped without `--version`, `--help` or
  unknown-flag rejection. Nothing ran the artifact before publishing it; now the release job asserts
  the binary's own reported version equals the VERSION file before it uploads anything.

### Changed
- **`GET /api/health`** answers liveness (`ok`, `version`, `uptimeMs`) to a plain `curl`, so probes
  and the install runbook work unauthenticated; `uid` and the notice text that explains a failure
  need the dashboard token, since together they describe the daemon's privilege level and on-disk
  layout before any task exists.
- **Daemon problems reach the dashboard.** Every boot warning — root, an empty project
  registry, a missing `gstack-review-read`, a host gate that will 403 your browser, a failed hooks
  write — go through `src/notices.ts` and surface as a banner. Warnings are dismissible; errors are
  not. They ride their own `/ws` frame rather than the task payload, which fires on every tool call.
  `journalctl` output is unchanged: every notice still prints `[code] message`.
- The card's error text is no longer truncated at 50 characters, and the drawer shows the full error
  plus the stderr tail — otherwise the captured diagnostic would have been unreadable.

### Security
- **Every interpolation in the task drawer is escaped.** `openTask` built HTML from `${t.phase}`,
  `${t.status}` and `${id}` unescaped. TODOS.md filed that as P4 defence-in-depth precisely because
  everything on that path was daemon-generated. Putting agent stderr into `task.error` retires that
  reasoning: it is now subprocess output, from a process running with permissions skipped, rendered
  into the page that carries the dashboard token. Truncation also moved to before escaping — cutting
  an escaped string can bisect an entity like `&#39;`.

### Internal
- A literal NUL byte, used as a separator inside the dashboard's notice-dismissal key, made the
  served HTML count as binary to strict `grep` implementations (ugrep, busybox), which report no
  match while the page renders perfectly in a browser — and the HTML tokenizer rewrites a NUL inside
  a `<script>` to U+FFFD anyway. GNU grep is unaffected, so this broke local tooling rather than
  GitHub CI. The suite now asserts the served page contains no control bytes.
- Two CI-only failures caught before pushing: a test that could only pass as root (it asserted a
  notice that is deliberately uid-gated), and the new `/api/health` assertion, which a runner
  without Claude Code correctly answers `ok:false`. The first became a uid-injectable unit test
  covering both branches; the second gives the smoke daemon a stub binary.
- Replacing an agent (every reply, and every resume) now waits for the outgoing `claude` to actually
  exit before starting its successor. It used to send SIGTERM and spawn immediately, so for as long
  as the old agent took to die two of them were appending to one session transcript and editing one
  worktree — silently. The concurrency slot is likewise released when a child closes, not when the
  signal is sent, so the cap is honest. A stubborn child is SIGKILL-ed after 5s.
- `src/agent.ts` gets its first tests. The supervisor's process handling had none at all before this,
  which is why the ENOENT crash shipped. `test/agent-spawn.test.ts` points `config.claudeBin` at
  throwaway shell scripts, so exit codes, signals, ENOENT and a 64KiB pipe overflow are exercised
  against real subprocesses — a mocked emitter cannot fill a pipe. The suite also stopped running
  against the operator's live `~/.agentdeck/agentdeck.db`: a preload now points it at a temp dir.
- Piping stderr moved journald backpressure from the child onto the daemon's heap, where nothing
  bounded it. The relay now checks `process.stderr.writableLength` before writing and skips the
  mirror once more than 1 MiB is unflushed, counting what it skipped. Checking `write()`'s return
  value instead would have been useless: `false` is advisory and the chunk is queued either way. The
  bounded tail that feeds `task.error` is unaffected, so diagnosis still works while the log stalls.
- An earlier design picked "the first meaningful line" of stderr as the cause, with ANSI stripping and
  carriage-return handling. Measuring the real failure killed it: the whole message is 93 bytes, one
  line, no ANSI — and with a tty stdin Claude Code prepends a stdin warning, so the first line is the
  wrong one. Keeping the bounded tail is both simpler and correct.

## [0.2.4.0] - 2026-08-04

### Added
- **Answering an agent is now a click, not a transcription job.** When an agent stops on a gstack
  decision brief, the reply drawer lists its options — letter, label, and which one it recommends —
  instead of leaving you to read a wall of prose and retype `B`. On a phone, where the whole
  human-in-loop promise lives, that is the difference between answering and postponing.

  Clicking an option **fills your reply; it does not send it.** The brief stays on screen above, the
  text stays editable so you can still add a sentence, and Send is unchanged. That is deliberate:
  headless Claude Code has no structured question tool, so gstack asks in prose and the dashboard
  parses it — and a parser reading prose is sometimes wrong. Keeping a confirmation step means a
  wrong guess is visible and costs nothing, rather than being dispatched to an agent running with
  skipped permissions.

  Nothing changes for a question that isn't a brief: no buttons, same free-text box as before.

### Internal
- `parseDecisionBrief` sits next to the existing detector in `src/detect.ts` and reuses its
  `BRIEF_MARKER` guard, so a finished review that merely bullets its findings `A) … B) …` never turns
  into clickable answers. It also refuses fewer than two options and any gap in the letters — real
  briefs are A, B, C…, so a gap means it latched onto prose that only looks like a list. It handles
  the three shapes gstack actually emits: plain lines, markdown bullets, and the bold inline
  split-chain buckets (`**A) Include**, **B) Defer**`), which a line-based pass would swallow whole.
- The parsed brief is derived per send and never persisted, so a parser improvement applies to
  agents that are already waiting — no migration, nothing to backfill.

## [0.2.3.1] - 2026-08-04

### Fixed
- **A website you visit can no longer read your board.** If a hostile page's domain resolves to
  `127.0.0.1` (DNS rebinding), the browser treats the daemon as same-origin and the page reaches it
  directly. Reads are open on localhost by design, so `GET /api/tasks` handed over every task title,
  prompt, branch, error and pending question. The `/ws` gate shipped in 0.2.3.0 could not stop this:
  it compared `Origin` against `url.host`, and both come from the attacker-controlled `Host` header,
  so they validated each other. Every route is now checked against a recognised `Host` **before
  routing** — reads included, since the reads were the leak.

  Nothing changes for the documented setup. Loopback names are accepted on **any** port, so
  `ssh -L 9000:127.0.0.1:8787` keeps working even though the browser sends `localhost:9000` while the
  daemon listens on 8787. `localhost.` and every `127.x.x.x` address count as loopback too. Behind a
  reverse proxy, set `AGENTDECK_ALLOWED_HOSTS` to the hostname your proxy sends — with or without a
  port, both match; without it, only loopback Hosts are accepted and the boot log says so.

### Internal
- The Host parser refuses anything that isn't a bare name plus an optional numeric port. "Ignore the
  port" must not decay into "ignore any suffix after a trusted name": the first cut discarded
  everything after the first `:` (or after `]`), so `[::1]evil.com`, `[::1]@evil.example` and
  `localhost:443:evil` all passed as loopback. Found by cross-model review, each case now locked by a
  test.
- The check runs ahead of `new URL(req.url)`, not merely ahead of routing. Bun builds that URL from
  the Host header, so a malformed Host made the constructor throw and Bun's fallback error page
  answered **500 with the attacker's Host echoed back**, an internal path and a stack frame. Reading
  the header directly needs no parsing and cannot throw. The unit test passed either way — only the
  integration test catches this one.

## [0.2.3.0] - 2026-08-04

### Added
- **The dashboard says what it is, and where it is.** The header is now two rows: a brand row
  carrying a deck glyph, the AgentDeck wordmark (a real page heading, so screen readers announce
  it) and a line telling you which deployment this tab points at and whether the link is alive —
  the one fact nothing else on screen carried when you keep several SSH tunnels open. Controls sit
  on their own row below. The browser tab finally has an icon, so AgentDeck is findable among ten
  others.
- **The connection indicator tells three states apart.** `live` in green, `reconnecting…` in
  amber, and `daemon unreachable` in red once it has really given up (and it now backs off instead
  of hammering every 1.5s while claiming otherwise). Restarting the daemon reads as a restart, not
  as a failure, and the board recovers on its own with no page reload.
- **`DESIGN.md`** at the repo root: the colour tokens with their roles, the contrast floors with
  measured ratios, the mono-as-identity decision, the header layout invariants, and the interaction
  states. Written because the approved brand lockup had been designed once and then quietly lost.

### Fixed
- **The live feed no longer leaks your board to any website you happen to have open.** WebSockets
  are not covered by the browser's same-origin policy, so any page could open `/ws` and receive the
  full task snapshot pushed on connect — titles, prompts, branch names, errors, pending questions.
  The upgrade is now gated on the dashboard token (sent as a subprotocol, never in the URL, so it
  can't land in proxy logs) plus an Origin check.
- **Text you couldn't read is now readable.** `--faint` measured 4.10:1 in dark and 2.80:1 in light
  — under the 4.5:1 floor for text and under even the 3.0:1 floor for interface elements — and it
  coloured section labels, metadata, timestamps and empty states. `--done` shipped with the exact
  same value and coloured the finished/stopped/resuming chips at 3.13:1. Both raised; every text
  colour now clears 4.5:1 in both themes.
- **The header is usable on a phone.** Its two controls measured 29px and 28px against a 44px
  minimum; they now meet it below 620px, and the bar no longer wraps unpredictably (two competing
  auto-margins were splitting the free space instead of pushing the status to the right).
- **The empty box next to every branch name is gone.** The branch mark was `U+2442`, a character
  almost no installed font carries, so most Linux systems drew a `.notdef` box on every task row —
  including in the README's demo GIF. It's now a drawn icon that doesn't depend on your fonts.

### Internal
- The dashboard token is persisted (0600, `O_EXCL`/`O_NOFOLLOW`, shape-checked) instead of being
  regenerated per process. Once the token also gated `/ws`, a per-process secret meant an open
  dashboard could never reconnect after a restart — it 403'd forever until you reloaded. Caught by
  the new end-to-end test, not by hand.
- New `docs/e2e/conn-states-e2e.mjs`: a browser proof of the connection state machine that costs no
  agent turn. It found the reconnect regression above on its first run. New assertions lock the
  brand lockup, the favicon and the contrast tokens, so the "designed once, silently dropped"
  failure mode that motivated this release can't repeat (89 tests).
- Cross-model pre-landing review (Claude + Codex) surfaced the WebSocket exposure, the `--done`
  contrast twin, an invalid `<h1>`-inside-`<span>` lockup, a hard-coded `ws://` that breaks behind
  an HTTPS proxy, and the token-file symlink handling. A DNS-rebinding vector on the ungated read
  endpoints predates this release and is tracked as P1.

## [0.2.2.0] - 2026-07-22

### Added
- **Auto-clean merged tasks (opt-in).** Set `AGENTDECK_AUTO_CLEAN_MERGED=true` and a periodic
  sweep (30s after boot, then every 5 min) drops a `done` task's worktree + branch + dashboard
  row once its branch is **proven merged** — no more manual "Clean up" on every shipped task.
  "Merged" is proven ONLY by a merged GitHub PR (`gh pr list --head <branch> --base <base>
  --state merged`) whose head commit equals the local tip, so a squash merge is detected where
  plain git can't. Off by default (it's a silent destructive sweep). `done` only — a `stopped`
  task is a deliberate pause and is never touched.

### Internal
- Safety-first by construction: the sweep only ever removes a task whose work is provably in the
  base. Detection returns the exact proven SHA and the branch is deleted via an atomic
  compare-and-swap (`git update-ref -d refs/heads/<b> <sha>`), so a commit landing after the proof
  is never force-deleted. The cleanup refuses a dirty or unreadable worktree, an in-flight guard
  prevents overlapping sweeps, `gh`/subprocess calls are bounded (SIGKILL + hard read deadline so a
  hung child can't wedge the sweep), and an anti-race re-check runs before the destructive step.
  Cross-model pre-landing review (Claude + Codex) drove the SHA compare-and-swap, the base filter,
  and dropping the unsafe `git --is-ancestor` fallback (it couldn't tell a merged branch from a
  zero-commit one). New `test/cleanup.test.ts` + `test/git.test.ts` cases (86 tests).

## [0.2.1.0] - 2026-07-22

### Added
- **Plan-review tracking on the dashboard.** Each task card now shows which of the three gstack
  plan reviews — CEO / Design / Eng — its branch has been through, as calm monochrome marks under
  the plan segment: `○` not run, `✓` clean, `⚠` ran-with-issues, trailing `*` = the review predates
  current HEAD. Eng is emphasized (it's the one that gates `/ship`). The daemon auto-detects this by
  reading the branch's gstack review log (`gstack-review-read`, run in the task's worktree) at each
  turn-end and once on (re)attach — no clicking, no manual state. Hover or screen-reader carries the
  detail (e.g. "Eng review: 13 issues, 0 unresolved"). The reader resolves from `PATH` first
  (override with `AGENTDECK_REVIEW_READ_BIN`); if it's missing the daemon logs once at boot and the
  marks simply stay `○`.

### Internal
- New `plan_reviews` column on `tasks`, added by an additive migration (independent of the `project`
  column, so a DB at any prior schema upgrades cleanly). Detection is best-effort and bounded — a 4s
  timeout+kill on the reader, an in-flight guard so at most one reader runs per task, and writes only
  on a clean, complete read (a killed or non-`clean`-exit reader never clobbers good marks). Short-SHA
  staleness compares by prefix so `git`'s auto-growing short hash doesn't flag the same commit stale.
  Pre-landing review (Claude + Codex, cross-model) hardened all of the above before merge.

## [0.2.0.2] - 2026-07-22

### Security
- **Upload destinations are now pinned to the exact intended dir.** The `/api/upload`
  path check confirmed the write landed under the project repo and not under `.git/`,
  but a pre-placed symlink at `<repo>/.gstack/browse-states` pointing elsewhere *within*
  the repo (e.g. → `src/`) still slipped through — a token-holder with local symlink
  access could drop a file into another repo dir. The check now requires the resolved
  directory to EQUAL the canonical `realpath(trusted base) + literal subpath`, so any
  symlinked path component is rejected: out of the repo, into `.git/`, or to another
  in-repo dir alike. (A residual TOCTOU race remains, inherent to pathname-based writes;
  tracked in TODOS for a future fd-based write.)

## [0.2.0.1] - 2026-07-22

### Fixed
- **QA cookies now actually reach the agent.** `/qa` confirmed the v0.2.0.0 cookie flow
  didn't work: an uploaded browse-state lands in the main repo's `.gstack/browse-states/`,
  but agents run in per-task worktrees and `$B state load qa` resolves that path via
  git-toplevel (the worktree root, which carries no `.gstack/`) — so the agent found nothing
  and QA ran logged-out. `createWorktree` now symlinks the worktree's
  `.gstack/browse-states` to the project repo's shared dir, so `$B state load qa` sees the
  uploaded state (proven end-to-end: `State not found` → `State loaded`). The symlink target
  is absolute (works with a relative `projects.json` path), and `.gstack/` is added to each
  managed repo's local `info/exclude` — so the untracked symlink never dirties the repo, never
  strands "Clean up", and can't be committed into your project branch by a cleanup. Upload path
  unchanged; cookies are never committed.

### Added
- **Drive many repos from one daemon.** Drop a `projects.json` (`[{ id, path, label? }]`)
  in the data dir and one AgentDeck instance orchestrates several repositories. The dashboard
  header gets a **Project** switcher (All projects / per-project), the choice is remembered
  across reloads, and in the all-projects view each row carries a muted project tag. Every
  task's branch and worktree land in that project's repo. Single-repo setups keep working
  unchanged — with no `projects.json`, a `default` project is synthesized from
  `AGENTDECK_TARGET_REPO`.
- **Upload a local file to the VPS from the browser.** A new **Upload** button sends a file
  over the tunnel (no more manual `scp`); it lands under `<dataDir>/uploads/<project>/` and a
  toast gives you the absolute VPS path with a copy button. Determinate progress bar, clear
  error states, 25 MB cap.
- **Authenticated QA on the VPS.** Upload a gstack browse-state (`qa.json`) into a project's
  `.gstack/browse-states/`, then the agent runs `$B state load qa` before the logged-in steps —
  so the headless browser on the server can hit pages behind a login. (Whether a worktree agent
  sees the main-repo copy is being verified in QA; see TODOS.)

### Security
- **All state-changing requests are token-gated (anti-CSRF).** Create/stop/delete/reply and
  upload now require a per-session **dashboard token**, injected into the served HTML (with
  `Cache-Control: no-store`) and sent as an `x-agentdeck-token` header. A cross-origin page
  can't read that token, so it can't forge these even while your SSH tunnel is open — closing a
  CSRF-to-localhost path that could otherwise launch a `--dangerously-skip-permissions` agent.
  This dashboard token is **separate** from the agents' `0600` hook token, which is no longer
  exposed in the page.
- **Upload path containment hardened.** The destination is now realpath-checked against a
  trusted base and any real `.git/` path is refused, so a symlinked directory component (e.g.
  `.gstack/browse-states` → `.git/hooks`) can no longer redirect a write out of the target dir.
  Filenames are reduced to a sanitized basename, project ids with path separators are rejected,
  and writes are temp-then-renamed (no stranded temp files, no leaf-symlink follow).

### Fixed
- **A stale or unknown project no longer runs an agent in the wrong repo.** `POST /api/tasks`
  with an unknown `projectId` returns 400 instead of silently falling back to the first project.
- **Worktree cleanup works for bare repos.** Cleanup derives the repo from the worktree; it no
  longer mis-derives a bare repo's path and leaks the worktree/branch.

## [0.1.3.11] - 2026-07-21

### Security
- **The hook endpoints now require a per-session token.** `/hooks/notification` and
  `/hooks/pre-tool-use` were unauthenticated — any local process could POST a forged
  `session_id` and flip a task to `waiting`. The daemon now generates a per-session secret
  (`hookToken`, `randomUUID` or `AGENTDECK_HOOK_TOKEN`), bakes `?token=<secret>` into the hook
  URLs in the generated settings file (Claude Code's `http` hook has no headers field), writes
  that file `0600` so only the owner can read the secret, and rejects any `/hooks/*` POST whose
  token doesn't match with **403**. The gate runs even when hooks are disabled. Forgery is now
  restricted to the owner user (who already controls the box); the prose-heuristic detection is
  unchanged. Hardened over two adversarial review rounds (empty-token footgun, write→chmod TOCTOU).

### Fixed
- **The drawer diff is capped at 4000 chars.** `openTask()` rendered `df.diff` uncapped
  (events were already capped), so a task touching many files bloated the drawer DOM. It now
  slices to 4000 chars with a "… N more chars truncated (see the worktree)" note. `esc()` still
  wraps the sliced string (slice-then-escape, so nothing is half-escaped).

## [0.1.3.9] - 2026-07-21

### Fixed
- **"Clean up" no longer dead-ends on a done task.** A done task's worktree is always dirty
  (the agent's artifact lives there uncommitted, and nothing else holds it), so
  `cleanupWorktree` safely refused it and the dashboard button just alerted with no way
  forward. `cleanupWorktree` now takes a `mode`: `safe` (default, refuse — nothing destroyed),
  **`commit`** (stage + commit the agent's work onto the branch, then remove the worktree —
  work preserved and PR-able later), or `force` (discard worktree + branch). The dashboard's
  "Clean up" / "Delete" tries `safe`, then on a dirty worktree offers **commit** (recommended)
  or a **discard** escape. `DELETE /api/tasks/:id?mode=commit|force` drives it (validated;
  defaults to `safe`). The `commit` uses a deterministic `AgentDeck` git identity so it works
  even in a repo with none configured.

### Hardened (review)
- **Cleaning up a running task stops its agent first.** `commit`/`force` now `killExisting`
  the live `claude` child before removing the worktree, so it can't be orphaned in the
  concurrency pool or race the `git commit`. Plus: guarded dashboard fetches, a structured
  `dirty` flag (no message-string coupling), a commit-failure → discard fallback, and honest
  discard copy (it deletes committed-but-unmerged branch work too). 5 `git.ts` integration
  tests cover all three modes; hardened over two adversarial review rounds.

### Fixed
- **A heavy gstack skill no longer strands as `done` when it stops to ask.** The daemon
  decides `waiting` vs `done` from the agent's turn text (`looksLikeQuestion`). A long
  `/plan-eng-review`-style turn ends on a decision brief whose *tail* is a `Net:` line with
  no question cue, so the old 500-char/narrow-cue check mis-read it as finished — leaving a
  real gstack agent stuck the moment it needed you. Detection now also does a structural
  check over the last 2000 chars: gstack's decision-brief shape (`Net:`/`Completeness:`
  lines or a `D<n> —` header, incl. split-chain `D<n>.final`/`.revise-k`, plus ≥2 labeled
  options — bold, bullet-listed, or inline), or an explicit "reply with a letter / your
  picks" instruction. Biased toward `waiting`, since stranding an asking agent is the worse
  error. A headless `BLOCKED — AskUserQuestion unavailable` message now reads as waiting too.
- **The reply drawer shows the actual question on a long turn.** `pendingQuestion` stored the
  *head* of the turn (the intro); for a long skill turn the asks are at the *end*, so it now
  keeps the tail (`…` + last 2000 chars).

### Validated
- **Full gstack loop end-to-end (P2).** A real `claude` agent ran `/plan-eng-review` through
  the daemon: it hit the skill's scope-gate `AskUserQuestion`, rendered it as prose, the
  dashboard flipped to `waiting`, an answer resumed it via `claude --resume`, and it ran the
  complete four-section eng review — proving a real gstack skill advances through the loop.
  This run surfaced the detection bug fixed above. Hardened via two adversarial review rounds
  (19 `detect.ts` unit tests pin every real brief shape).

## [0.1.3.7] - 2026-07-20

### Added
- **Browser e2e harness** (`docs/e2e/`) — a reproducible end-to-end proof of the core loop
  with a **real** claude agent: it drives the actual dashboard (click "New task" → the agent
  asks in prose → `waiting` over WebSocket → reply drawer → `claude --resume` → done →
  artifact on disk). Isolated deps; not wired into CI (a real agent costs money + is
  non-deterministic). Proves the P2 "real task creation from the browser" item.

### Changed
- TODOS: closed the browser-e2e P2, and recorded a P3 found during it — the dashboard's
  "Clean up" button dead-ends on a done task whose worktree is dirty with the agent's artifact
  (`cleanupWorktree` safely refuses, but the UI gives no path forward).

### Hardened (review)
- **The e2e cleanup can't leak a real agent.** `run.sh` launches the daemon in its own process
  group (`set -m`) and tree-kills it on exit (`kill -- -$PGID`), so a mid-run failure/timeout
  can't orphan the spawned `claude` — which would otherwise keep burning tokens against a
  `rm -rf`'d worktree. Plus: the daemon log now lives at a stable (gitignored) path so it
  survives cleanup for diagnosis, and a pre-flight port check fails loud instead of silently
  driving a stale daemon on 8788.

## [0.1.3.6] - 2026-07-20

### Changed
- **Dashboard + notifications translated to English.** Every user-facing string in the
  Master Inbox (`public/index.html`) and the Slack/Telegram templates (`src/notify.ts`)
  is now English (`Cruising / Needs you / Done`, the reply drawer, empty state, buttons,
  alerts, relative times). Hardened via `/plan-eng-review` (Codex outside voice).

### Added
- **Reproducible demo-GIF harness** (`docs/demo/`) — boots the real dashboard, drives the
  state timeline over the live WebSocket, captures with headless Chromium, and encodes the
  GIF (deps isolated here; the root package stays dependency-free). The capture **fails on
  any dashboard console error**, so it doubles as a UI-integrity check.
- Regenerated `docs/demo.gif` in English.

## [0.1.3.5] - 2026-07-20

### Added
- **Install with Claude Code** — a copy-paste prompt (README) that installs gstack (if missing)
  + AgentDeck and sets up a `systemd --user` service in one paste. It checks whether gstack is
  already installed, is idempotent, validates the download and the target repo, and bakes the
  runtime PATH into the service so the daemon can actually spawn `claude` agents. Hardened via
  `/plan-eng-review` (Codex outside voice; core-critical bar).

### Docs
- Refreshed the stale status version and completed the `AGENTDECK_*` config-knobs list.

## [0.1.3.4] - 2026-07-20

### Changed
- **Full rename of the internal `gorch` codename to AgentDeck.** Environment variables
  `GORCH_*` → `AGENTDECK_*`, the git branch prefix `gorch/` → `agentdeck/`, the state DB
  `gorch.db` → `agentdeck.db`, the default data dir `~/.gorch` → `~/.agentdeck`, the daemon
  log line, and the `GorchConfig` type. No behavior change — the codebase is now gorch-free.

## [0.1.3.3] - 2026-07-20

### Changed
- **Dashboard branding.** The header wordmark, browser title, and empty-state copy now read
  **AgentDeck** (was the internal codename `gorch·inbox`). Regenerated the demo GIF to match,
  and switched its sample task IDs to the real `t_…` format so nothing off-brand shows.

## [0.1.3.2] - 2026-07-20

Public-readiness pass.

### Added
- **MIT license** (`LICENSE`) — the repo is now legally usable, forkable, and distributable.

### Docs
- README cleaned for a public audience: dropped the internal `spike` section and the
  `A1`/`A1b` proof codenames + dated validation logs, folded the launch requirement into
  its own section, and refreshed the status version.

## [0.1.3.1] - 2026-07-20

### Docs
- **Demo GIF** (`docs/demo.gif`, shown in the README): the Master Inbox with several agents
  cruising, one flipping to `waiting`, the reply drawer opening, an answer typed, and the task
  resuming. Captured from the real server + dashboard driven over its live WebSocket.

## [0.1.3.0] - 2026-07-20

The distribution pipeline (T8). AgentDeck now ships as a single self-contained binary — distribution is the product for an OSS repo.

### Added
- **Single-binary build.** `bun run build` compiles `src/daemon.ts` to a standalone
  executable (`dist/agentdeck`) via `bun build --compile`. The dashboard HTML is embedded
  into the binary (`import indexHtml from "../public/index.html" with { type: "text" }`),
  so it runs from any cwd with no sibling `public/` — verified booting + serving from `/tmp`.
- **Release workflow** (`.github/workflows/release.yml`). Pushing a `v*` tag runs the tests,
  cross-compiles three targets (linux x64/arm64, darwin arm64) from one runner, and uploads
  them to a GitHub Release. All three targets verified to cross-compile locally.
- **CI workflow** (`.github/workflows/ci.yml`). On push/PR: runs the 18 unit tests and
  compiles all three release targets, so a broken cross-target fails the PR, not the tag.
  Pinned to least-privilege `permissions: contents: read`.
- **README install section.** Single-binary `curl` + `chmod` instructions, a "Run from
  source" section, and a demo-GIF placeholder (recording tracked in TODOS).

### Hardened (review)
- **The release actually gets exercised.** CI now smoke-runs the compiled linux-x64
  binary (boots it, curls `/`, asserts the dashboard) and a unit test boots the server
  and asserts `GET "/"` serves the embedded HTML — the pipeline compiled the binary but
  never ran it, so the embed change had zero runtime coverage.
- **Release guardrails.** `release.yml` verifies the pushed tag equals `v<VERSION>` before
  building, and `fail_on_unmatched_files: true` stops it publishing an empty release (and
  404-ing the README download links) if the artifact glob ever misses.

## [0.1.2.2] - 2026-07-20

Two fixes surfaced by the first real end-to-end run; the second was a critical caught in review.

### Fixed
- **Untracked files show in the diff view.** A file an agent just created was invisible
  (`git diff` ignores untracked). Read via `git status --porcelain -z` so paths with
  spaces / accents / newlines survive; list capped; empty returns "".
- **Single-source the agent turn text.** The turn's text now comes from one source — the
  consolidated assistant message. The previous code accumulated deltas *and* the assistant
  message (doubling the question), and a substring-dedup meant to fix that could drop a
  restated question and — since detection only reads the trailing 500 chars — silently flip
  an agent from `waiting` to `done`, stranding it. Deltas are liveness-only now.

## [0.1.2.1] - 2026-07-20

### Docs
- Record the validation result: Claude Code's `Notification` hook does **not** fire under
  headless `claude -p` (the `Stop` hook does, but it's redundant with the stream `result`
  event). The prose heuristic on turn-end is the detection mechanism and it's optimal for
  the headless model. The `Notification` wiring stays opt-in/off, ready for a future
  interactive mode; the HTTP hook transport itself is confirmed working.

## [0.1.2.0] - 2026-07-20

Opt-in Notification-hook wiring for faster "waiting" detection, hardened after review.

### Added
- **Notification-hook wiring (opt-in, `AGENTDECK_HOOKS=true`)**: launched agents load a
  generated settings file via `claude --settings`, so Claude Code POSTs its `Notification`
  (and PreToolUse) HTTP hooks to the daemon — a first-class "needs you" signal that also
  covers permission prompts. The prose heuristic stays primary; the hook corroborates and
  speeds detection. **Off by default** until validated on a VPS.
- `src/hooks-config.ts`: pure settings generator (+ 3 tests).

### Fixed
- **One live child per task (critical)**: a Notification-driven `waiting` can fire while
  the agent is still running; `answer()`/`resumeTask()` now kill the existing child first
  and the exit handler is identity-guarded — no two concurrent `claude --resume` on one
  session, no orphaned or false-error tasks.
- The settings-file write is guarded — a failure degrades to hooks-off instead of crashing
  the daemon.
- Cap the hook message length (2000); skip our `--settings` if the operator passed their own.

## [0.1.1.0] - 2026-07-19

Reply-drawer polish, accessibility, and the first tests.

### Added
- Master Inbox: a **pending-question preview** on waiting agent rows;
  **Cmd/Ctrl+Enter** to submit in the reply and new-task drawers; **Escape** to close
  (unless a non-empty textarea is focused).
- **Screen-reader support**: an `aria-live` region announces agents flipping to
  waiting / error / done — appends one node per message so a burst isn't clobbered,
  and seeds silently on first load so a page reload doesn't announce the whole board.
- **Unit tests (15)** for the state-detection logic: `looksLikeQuestion` + phase mapping.

### Changed
- Extract `looksLikeQuestion` into `src/detect.ts` (pure, testable module).

### Fixed
- Restore the standalone "option" cue in `looksLikeQuestion` — a prose question ending
  in "select an option" was mis-classified as done, stranding a waiting agent (with a
  regression test).
- Isolate each dashboard row render so one bad task can't blank the whole board.
- `esc()` also escapes `'` and `` ` `` (defense in depth).

## [0.1.0.0] - 2026-07-19

First cut. The daemon spine runs end to end and the make-or-break mechanic is proven.

### Added
- **Daemon (`src/`)** — Bun + SQLite. Task lifecycle: `1 task = 1 branch = 1 worktree = 1 agent`.
  - `agent.ts` — headless agent supervisor. Drives Claude Code via the Agent SDK / `claude -p`
    (Path A, no tmux substrate). Human-in-loop = the proven **prose + `claude --resume`** mechanic;
    injection and A2 durability are the same operation. Concurrency cap enforced.
  - `git.ts` — non-destructive worktrees (never `-D`/`--force`; dirty/unmerged trees are surfaced).
  - `db.ts` — SQLite in WAL mode (tasks + events).
  - `phase.ts` — gstack skill → pipeline phase mapping (Plan→Run→Review→QA→Ship→Done).
  - `notify.ts` — Slack + Telegram, notification-only (reply happens in the dashboard).
  - `server.ts` — REST + WebSocket + HTTP hooks. Binds `127.0.0.1` by default (reach via SSH tunnel).
- **Dashboard (`public/index.html`)** — the Master Inbox: attention hierarchy (waiting/error pinned,
  running/done recede), 6-phase progress bars, reply drawer, live over WebSocket.
- **Spike (`spike/`)** — the instrument that proved A1: in headless mode the AskUserQuestion tool is
  unavailable, the agent asks in prose, and a `claude --resume` turn injects the answer and continues.

### Validated
- **A1b — resolved.** A real gstack skill runs headless, asks in prose (no `BLOCKED`), and a
  `claude --resume` turn continues it. Launch config: agents start with
  `--dangerously-skip-permissions` (`AGENTDECK_SKIP_PERMISSIONS`, default on). Path A proven end to end.

### Next
- Reply drawer wired to the `Notification` hook, `resuming` state UI, `aria-live` (DT1–DT3).
- Confirm a *valid* answer advances a gstack workflow (the A1b test used an invalid answer, so the
  agent re-asked — the round-trip mechanic is proven, full-flow advance is the follow-up).
