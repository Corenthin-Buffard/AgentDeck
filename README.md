# AgentDeck

Self-hosted, **gstack-native** orchestrator for running multiple Claude Code agents in parallel on a VPS. An air-traffic-control board for your agents: one glance tells you which agent needs you, which is cruising, which broke.

`1 task = 1 branch = 1 git worktree = 1 agent.` Strict isolation, no sharing. Agents run on the server, so they keep going when you close your laptop or drop the SSH connection.

<p align="center">
  <img src="docs/demo.gif" width="820"
       alt="AgentDeck Master Inbox: several agents cruising, one flips to waiting, you reply in the drawer, and it resumes.">
</p>

<p align="center"><sub>One agent flips to <code>waiting</code>, you answer in the drawer, and it resumes — live over WebSocket.</sub></p>

> Status: **v0.2.5.1** — early but working end to end. The full loop runs with a real agent: create a task → branch → git worktree → the agent runs → it asks a question in prose → you reply from the dashboard → `claude --resume` continues → done, with the artifact on disk. Ships as a single self-contained binary (see **Install**). Not yet production-hardened.

## Why this and not Claude Squad / Conductor / amux

Those orchestrate agents generically. AgentDeck is coupled to the **gstack workflow**: it *drives* each agent through the `Plan → Run → Review → QA → Ship → Done` pipeline, one turn per step, and the board shows where each one is because the daemon is the thing that put it there. The human-in-loop moment is a first-class feature. Narrow on purpose — built for people who already run Claude Code + gstack.

## How it works

```
                     ┌──────────────────────────────────────────────┐
   Browser ──WS──────┼─▶ AgentDeck daemon (Bun, systemd, non-root)    │
   Slack/Telegram ◀──┼── notification-only (reply in the dashboard)   │
                     │   Agent supervisor: N × headless Claude Code    │
                     │   Preview supervisor: dev servers on a port pool│
                     │   State store (SQLite, keyed by sessionId)      │
                     └───▲──────────────────────────────▲──────────────┘
                         │ HTTP hooks / SDK stream       │
              ┌──────────┴───┐                    ┌──────┴───────┐
              │ Agent 1       │  ...               │ Agent N      │
              │ cwd=worktree-1│                    │ cwd=worktree-N│
              └───────────────┘                    └──────────────┘
                 git worktree                         git worktree
                      ▲                                    ▲
                      │ same worktree, on demand           │
              ┌────────┴────────┐                  ┌────────┴────────┐
              │ dev server :8788│  (pool)          │ dev server :8789│
              └─────────────────┘                  └─────────────────┘
                 Browser ──────── ssh -L 8788 ─────────▶ (loopback only)
```

The preview row is opt-in per project and per click: nothing starts a dev server
unless you press **Preview**. See [Preview what an agent built](#preview-what-an-agent-built).

**The human-in-loop mechanic (proven):** in headless mode Claude Code has no AskUserQuestion tool, so the agent asks in **prose** and the turn ends. AgentDeck reads the question, notifies you (Slack/Telegram), and when you reply in the dashboard it injects the answer as a new `claude --resume <sessionId>` turn. That same `resume` is also how agents survive a daemon restart — injection and durability are one operation.

**A daemon restart is not an outage.** Rebuilding or restarting drops every open
dashboard's WebSocket. The board says so in three distinct states rather than
freezing on stale data, and it recovers on its own — no page reload, because the
dashboard token is persisted across restarts.

<p align="center">
  <img src="docs/demo-conn.gif" width="820"
       alt="The dashboard header: live in green, then reconnecting in amber when the daemon stops, then daemon unreachable in red, then back to live on its own once it returns.">
</p>

**How "waiting" is detected:** a headless agent can't interrupt mid-turn — under `claude -p`, Claude Code's `Notification` hook doesn't fire (only `Stop` does, which is redundant with the turn-end `result` event). So when a turn ends, the daemon reads the `result` and decides waiting-vs-done from the prose. The prose heuristic is the signal.

The `Notification`-hook wiring still ships but is **off by default** (`AGENTDECK_HOOKS=true`). The HTTP hook transport works; `Notification` is simply inert under `claude -p`, and it's kept ready for a future interactive / SDK (`query()` + Channels) mode where it would fire.

## Install with Claude Code (recommended)

Run this **in a Claude Code session on the machine where AgentDeck should live** (your VPS, not your laptop). Claude Code has shell access — paste the prompt and it installs gstack (if it's missing), downloads AgentDeck, asks for your target repo, and sets up a systemd service. It checks first whether gstack is already installed, is idempotent, and stops with a clear message if anything's off.

**It never installs a daemon that runs as root.** If you're root, it creates a dedicated unprivileged account and a system unit for it — because Claude Code refuses `--dangerously-skip-permissions` under uid 0, so a root daemon fails every task at spawn, in milliseconds.

<details>
<summary><b>📋 Copy this prompt into Claude Code →</b></summary>

```text
Install AgentDeck (a self-hosted orchestrator for parallel Claude Code agents) and gstack (its required workflow toolkit) on THIS machine. Be idempotent, print each step, and STOP with a clear message if a check fails. Use absolute paths — do not assume PATH changes persist between your shell commands.

This runbook is deliberately short. `scripts/setup-agent-user.sh --check` enumerates everything the daemon and its agents need, and every line it fails prints the exact command that fixes it. Your job is the handful of things a script cannot decide: which account, which credentials, which repo, which key. Let the tool tell you the rest.

0. PREFLIGHT — decide WHICH ACCOUNT runs the daemon. First decision, not a detail.
- Detect OS/arch (`uname -s` / `uname -m`) and confirm `git` is present.
- Run `id -u` and pick the mode:
    not 0                -> MODE = SELF.      The daemon runs as me, under `systemd --user`.
                            RUN_USER=$USER, RUN_HOME=$HOME.
    0 and uname -s=Linux -> MODE = DEDICATED. Create an unprivileged service account and a SYSTEM unit.
                            RUN_USER=agentdeck, RUN_HOME=/var/lib/agentdeck.
    0 and not Linux      -> STOP. No `useradd`/systemd here; tell me to re-run as an unprivileged user.
- Tell me the mode and WHY, in one line: Claude Code refuses `--dangerously-skip-permissions` under uid 0, so a daemon running as root fails every task at spawn. A root install is not something this runbook produces.

- RUN-AS CONVENTION (DEDICATED). Every step that says "as RUN_USER" means exactly this shape:
    su -s /bin/bash agentdeck -c "export HOME=/var/lib/agentdeck PATH=/usr/local/bin:/usr/bin:/bin:/var/lib/agentdeck/.local/bin; <command>"
  Never drop the `HOME=` or the `PATH=`; neither is inherited. `su` without `-` keeps ROOT's HOME, so a `curl | bash` installer writes into /root and then fails on permissions. And a non-interactive shell never sources `.bashrc`, so `~/.local/bin` is not on PATH unless you put it there — that is where `claude: command not found` comes from. The account's shell is `nologin` on purpose; `su -s /bin/bash` is the way in.
  In SELF mode, "as RUN_USER" just means: run it normally.

- HUMAN-ONLY RULE. NEVER run an interactive authentication flow yourself: `claude auth login`, `gh auth login`. They wait for a human to open a URL and paste a code back, for minutes. Run by an agent they blow past the timeout and get killed, and the error that comes out looks like a broken account rather than an interactive flow with nobody to answer it. PRINT the full command — HOME and PATH included — and STOP.
  When I run one and it prints a sign-in URL: that URL is wrapped in a terminal hyperlink escape, so it appears TWICE back to back. Copying the whole thing gives a truncated URL missing `scope=`, and the browser answers "Invalid OAuth request: missing scope parameter" — which looks like a broken account and is just a bad paste. Take the first copy only.

1. PROVISION — the mechanical half (DEDICATED)
- Get the script (from a clone: `scripts/setup-agent-user.sh`; or download it):
    curl -fsSL https://github.com/Corenthin-Buffard/AgentDeck/releases/latest/download/setup-agent-user.sh -o /tmp/setup-agent-user.sh && chmod +x /tmp/setup-agent-user.sh
  Same release as the binary in step 3, on purpose: a script from one version and a daemon from another is an install nobody tested.
- Run it: `sudo /tmp/setup-agent-user.sh --user agentdeck --home /var/lib/agentdeck`
  It creates the account, its directories, `/etc/systemd/system/agentdeck.service`, and reloads systemd. It is idempotent, and it deliberately does NOT enable or start anything — the daemon cannot work before credentials and a repo.
- Do NOT create anything else in that home with `sudo` afterwards: root-owned directories under RUN_HOME read as healthy until an agent writes. `--check` catches it.
- SELF mode: no script. Write `$HOME/.config/systemd/user/agentdeck.service` yourself, with REAL newlines:
    [Unit]
    Description=AgentDeck daemon
    After=default.target
    [Service]
    ExecStart=%h/.local/bin/agentdeck
    EnvironmentFile=%h/.config/agentdeck/env
    Environment=PATH=<paste the CURRENT interactive $PATH here>:%h/.local/bin:%h/.bun/bin
    Restart=on-failure
    RestartPreventExitStatus=78
    [Install]
    WantedBy=default.target
  `RestartPreventExitStatus=78`: exit 78 is an unrecoverable config error (today, the port is already bound). Without it `Restart=on-failure` retries forever against a port that stays busy. Then `loginctl enable-linger "$USER"` so it survives logout — if that fails, say plainly that persistence is NOT set up rather than claiming it is.

2. STOP — Claude Code credentials for RUN_USER. My decision, my hands.
  Present both, pick neither:
    (a) `claude auth login` as RUN_USER — its own session, durable. The subcommand is `auth login`, NOT `login`: the bare word is parsed as a PROMPT, and the authentication error it returns looks exactly like a dead session.
          su -s /bin/bash agentdeck -c 'HOME=/var/lib/agentdeck PATH=/usr/local/bin:/usr/bin:/bin:/var/lib/agentdeck/.local/bin claude auth login'
    (b) copy my `~/.claude/.credentials.json` to $RUN_HOME/.claude/.credentials.json (chown to RUN_USER, 0600).
        Immediate, and it ROTS: the OAuth refresh token rotates, so the copy works only until MY session refreshes, after which every agent fails at authentication. Measured — dead within hours. A stopgap, nothing more.
  Per the HUMAN-ONLY rule: print the command, do not run it. `--check` reads `claude auth status`, so it will tell us whether this actually worked.

3. STOP — the target repo. My decision.
- Ask me for the ABSOLUTE path, and VALIDATE it: `git -C "<path>" rev-parse --git-dir`.
- In DEDICATED mode, RUN_USER must be able to write it. Present both, pick neither:
    (a) share it: `chown -R agentdeck: <repo>` — and then ALSO `git config --global --add safe.directory <repo>` for every other user who works in it, or git answers them `fatal: detected dubious ownership` and I will think you broke my repo;
    (b) clone it somewhere neutral (e.g. /srv/<project>) owned by RUN_USER, leaving my copy alone.
- Write `$RUN_HOME/.config/agentdeck/env` (systemd EnvironmentFile format: one KEY=VALUE per line, no quoting, no shell expansion; warn me if a value contains spaces, `%` or `#`): AGENTDECK_HOST=127.0.0.1, AGENTDECK_PORT=8787, AGENTDECK_TARGET_REPO=<path>, plus any of AGENTDECK_SLACK_WEBHOOK / AGENTDECK_TG_TOKEN + AGENTDECK_TG_CHAT. In DEDICATED mode the script already seeded this file — edit it, keep it owned by RUN_USER at 0600.
- Do NOT set AGENTDECK_ALLOW_ROOT. It exists for a machine where no service account can be created, and this install has one.

4. STOP — the agent's git identity. My action.
- SSH key: generate a DEDICATED one as RUN_USER (`ssh-keygen -t ed25519 -C "agentdeck@$(hostname)"`), print the public key, and tell me to add it as a **deploy key with write access** on the repos agents will push to. Do not copy my own account key onto the box: it grants write access to EVERY repo I can touch.
- Host key: seed it, as RUN_USER — `ssh-keyscan github.com >> ~/.ssh/known_hosts`. The daemon runs under systemd with no tty, and SSH's default is to ASK before trusting an unknown host. Unseeded, the agent's first push dies on `Host key verification failed` with nobody to answer.
- `gh`: the agent needs it authenticated, or it does the whole task and falls over at `/ship`. Prefer a **fine-grained token limited to the target repo**, set as GH_TOKEN in the env file. The `gh auth login` device flow is the fallback, and it mints a token carrying `repo` — write access to ALL my repos, wider than the deploy key we just scoped to one. `--check` warns when that is what it finds.

5. GATE — let the tool say what is missing.
    sudo /tmp/setup-agent-user.sh --user agentdeck --home /var/lib/agentdeck --check   # DEDICATED
    ./setup-agent-user.sh --user "$USER" --home "$HOME" --check                        # SELF (no sudo)
  It exits 0 (ready), 2 (the daemon will run but a flagged part of the workflow will not) or 1 (broken). EVERY failing line prints the command that fixes it — run it, then run `--check` again. Repeat until it stops finding things. Read the final state back to me; do not proceed past a 1.

6. ENABLE
    systemctl enable --now agentdeck            # DEDICATED
    systemctl --user daemon-reload && systemctl --user enable --now agentdeck   # SELF

7. VERIFY, then prove it with a real task.
- `GET /api/health`, not the page title: a misconfigured daemon serves a perfectly good dashboard while every task dies.
    curl -s http://127.0.0.1:8787/api/health      # "ok": true, and uid NOT 0
  If `ok` is false, the diagnostic half is token-gated (it reports the daemon's uid and the paths it reads). The token lives in RUN_HOME:
    TOKEN=$(cat "$RUN_HOME/.agentdeck/dashboard-token")
    curl -s -H "x-agentdeck-token: $TOKEN" http://127.0.0.1:8787/api/health
  The `notices` array says what is wrong. Read it back to me and STOP.
- WITNESS TASK — the acceptance test. Create ONE task on the target repo that: prints `id -u`, lists its `plan-*` skills, writes a file, commits it, and PUSHES it.
  **Verify the ARTIFACT, not the task status.** A task whose agent fails to authenticate is currently marked `done`, with no error and an empty worktree — a green board is not evidence:
    cat <worktree>/witness.txt                                          # the service uid
    su -s /bin/bash agentdeck -c 'git -C <worktree> log --oneline -1'   # the commit exists
    git -C <repo> ls-remote origin 'refs/heads/agentdeck/*'             # same SHA on the remote
  The `su` is not decoration: the worktree belongs to the agent, so git answers root `dubious ownership`.
  If the three do not agree, the install is not finished no matter what the board says.

8. DONE — summarize: mode and WHICH USER the daemon runs as, what `--check` finally reported, `/api/health` ok + uid + notices, what the witness task actually left on the remote, and anything still on me (the deploy key, a fine-grained token).
- Dashboard: http://127.0.0.1:8787 (localhost-bound). From my laptop: `ssh -L 8787:127.0.0.1:8787 user@vps` then http://localhost:8787. To use Preview, forward the dev-server pool too (`-L 8788:127.0.0.1:8788 -L 8789:127.0.0.1:8789 -L 8790:127.0.0.1:8790`).
```

</details>

Prereqs on the box: `git`, plus `claude` (authenticated) and gstack **for the account the daemon runs as** — which, if you install as root, is the service account the prompt creates, not you. `bun`, `bunx` and `node` are needed by gstack's own setup (and by the source-build fallback). You don't have to track that list: `scripts/setup-agent-user.sh --check` does, and prints the command for whatever is missing. Not on Linux with systemd? The prompt still installs everything and runs the daemon — it just tells you persistence isn't wired up (set up `launchd`/a process manager yourself).

### When it breaks, start from the message

Every one of these cost a round trip during a real install, because each message points somewhere other than its cause. This is an index — the explanation lives at the step named on the right.

| What you see | What it is | Where |
|---|---|---|
| `claude: command not found` under `su` | the PATH wasn't passed | step 0, RUN-AS convention |
| `Failed to authenticate: OAuth session expired` | dead session, **or** `claude login` instead of `claude auth login` | step 2 |
| `Invalid OAuth request: missing scope parameter` | truncated sign-in URL (it is printed twice) | step 0, HUMAN-ONLY rule |
| `mkdir: permission denied` under the agent's home | root-owned directories from a `sudo` | step 1, and `--check` → *home ownership* |
| `Permission denied (publickey)` on push | deploy key not registered | step 4, and `--check` → *remote* |
| `Host key verification failed` | `known_hosts` never seeded, and no tty to accept | step 4, and `--check` → *remote* |
| `fatal: detected dubious ownership` | `chown -R` without `safe.directory` for the other users | step 3 |
| Task `done` in seconds, empty worktree | the agent failed to authenticate; reported as success | step 7 — verify the artifact |

## Install manually (binary)

Grab the single binary for your platform from [Releases](https://github.com/Corenthin-Buffard/AgentDeck/releases/latest) — the dashboard is embedded, so it's self-contained (no runtime, no `node_modules`, no sibling files):

```bash
# Linux x64 (swap the suffix for -linux-arm64 or -darwin-arm64)
curl -fsSL https://github.com/Corenthin-Buffard/AgentDeck/releases/latest/download/agentdeck-linux-x64 -o agentdeck
chmod +x agentdeck
AGENTDECK_TARGET_REPO=/path/to/your/project ./agentdeck
# → http://127.0.0.1:8787  (bind is localhost — reach it via an SSH tunnel)
```

On the box it drives you still need `claude` (Claude Code) on PATH and authenticated, plus gstack for the phase tracking — the binary bundles AgentDeck, not the agents it runs.

Run it under systemd to survive your laptop closing (that's the whole point — the daemon keeps the agents going while you're away): a `--user` unit if you install as yourself, a system unit under a dedicated account if you're root. **Don't run it as root** — Claude Code refuses `--dangerously-skip-permissions` at uid 0 and every task dies at spawn; see [Don't run the daemon as root](#dont-run-the-daemon-as-root).

## Run from source

Prereqs: [Bun](https://bun.sh), `claude` (Claude Code) on PATH and authenticated, and gstack for the phase tracking.

```bash
bun install   # (no deps yet, but conventional)
AGENTDECK_TARGET_REPO=/path/to/your/project \
AGENTDECK_TG_TOKEN=... AGENTDECK_TG_CHAT=... \
bun run daemon
# → http://127.0.0.1:8787  (bind is localhost — reach it via an SSH tunnel)

bun run build     # → dist/agentdeck, the same self-contained binary CI ships
```

Config knobs (env): `AGENTDECK_HOST` (default `127.0.0.1`), `AGENTDECK_PORT` (`8787`), `AGENTDECK_TARGET_REPO` (default: cwd — seeds the `default` project when there's no `projects.json`), `AGENTDECK_DATA_DIR` (default `~/.agentdeck` — SQLite DB + worktrees + uploads + `projects.json`), `AGENTDECK_WORKTREES`, `AGENTDECK_UPLOADS` (default `<dataDir>/uploads`), `AGENTDECK_MAX_AGENTS` (`4`), `AGENTDECK_PREVIEW` (on; `false` disables the Preview button), `AGENTDECK_PREVIEW_PORTS` (`8788-8790` — the dev-server pool; sets reachability *and* concurrency, see [Preview what an agent built](#preview-what-an-agent-built)), `AGENTDECK_PREVIEW_TTL_MS` (4h; `0` disables), `AGENTDECK_PREVIEW_MEM_MAX` (`1G`), `AGENTDECK_PREVIEW_READY_TIMEOUT_MS` (60s), `AGENTDECK_PREVIEW_INSTALL_TIMEOUT_MS` (10min), `AGENTDECK_PIPELINE` (off — ticks the gstack-pipeline box by default on new tasks; see [The gstack pipeline](#the-gstack-pipeline)), `AGENTDECK_CLAUDE_BIN` (`claude`), `AGENTDECK_REVIEW_READ_BIN` (gstack-review-read; resolved from PATH — the `[plan-reviews]` boot notice names it when missing), `AGENTDECK_SKIP_PERMISSIONS` (default on — `--dangerously-skip-permissions`; set `false` to disable), `AGENTDECK_PERMISSION_MODE` (`acceptEdits`, used only when skip is off), `AGENTDECK_CLAUDE_ARGS`, `AGENTDECK_ALLOWED_HOSTS` (comma-separated Hosts accepted besides loopback — needed behind a reverse proxy, see [Upload files to the VPS](#upload-files-to-the-vps)), `AGENTDECK_AUTO_CLEAN_MERGED` (off; `true` periodically drops a done task's worktree, branch and row once its branch is merged), `AGENTDECK_HOOKS` (opt-in Notification hooks, off by default), `AGENTDECK_HOOK_BASE_URL`, `AGENTDECK_HOOK_TOKEN` (per-session secret agents use for hooks), `AGENTDECK_DASHBOARD_TOKEN` (per-session secret the browser uses for writes/uploads — injected into the served HTML), `AGENTDECK_TG_TOKEN`/`AGENTDECK_TG_CHAT`, `AGENTDECK_SLACK_WEBHOOK`.

`AGENTDECK_ALLOW_ROOT` exists too, and is deliberately not in that list: it is an escape hatch for a machine where no service account can be created, not a configuration choice — see [Don't run the daemon as root](#dont-run-the-daemon-as-root).

## The gstack pipeline

Tick **Follow the gstack pipeline** on a new task and the daemon runs it as a
sequence, one `claude -p` turn per step:

| # | phase | step |
|---|-------|------|
| 1 | plan | `/spec` — turn the request into an executable spec |
| 2 | plan | `/autoplan` — CEO, design, eng and DX plan reviews, auto-decided |
| 3 | run | implement the approved plan |
| 4 | review | `/review` the diff |
| 5 | qa | `/qa`, and fix what it finds |
| 6 | ship | `/ship` — commit, push, open the PR |
| 7 | ship | `/canary` |

**The daemon drives it; the agent is not merely asked to.** That distinction is the
whole design. A turn ends when the model stops, and AgentDeck reads a quiet result
as `done` — so an agent *instructed* to follow a sequence would be marked complete
the moment it finished step 1 and wrote a summary. Because the daemon issues each
step, `phase` is something it knows rather than infers.

Each step runs in a **fresh session**. Seven heavy skills in one context would
compact, and a compacted agent that loses the thread just ends its turn. Steps hand
off through gstack's own artifacts instead — the spec file, `*-reviews.jsonl`, the
test plan.

A question **does not** advance the step: answering resumes that step's session, so
the step you were asked about is the one that finishes. A turn that *fails* (API
error, abort) retries, bounded per step. A step that *runs* and reports it cannot
proceed stops the task — it will not go better the second time.

**`/ship` is told not to bump `VERSION` or edit `CHANGELOG.md`.** Every agent works
in its own worktree, so there is no concurrent write; the collision is a *merge*
conflict when the second PR lands, which no amount of scheduling prevents. Removing
the per-task bump removes the conflict — you bump once, at merge.

Leave the box unticked for a free-form task: the agent gets your instructions
verbatim and the phase bar is inferred from activity, exactly as before. The board
distinguishes the three cases — driven, free-form (muted, dashed), and *commanded
but nothing happened* (amber, "pipeline did not run"), which is what you see if a
step finishes without invoking the skill it was told to.

Off by default while it earns its baseline: set `AGENTDECK_PIPELINE=true` to tick
the box by default. Override the step table by dropping a `pipeline-steps.md` in the
data dir — one step per paragraph, `<phase> [/skill]` on the first line, the
instruction beneath. It is read lazily and every problem degrades to the built-in
table with a notice on the dashboard, including one that names a skill the board
cannot track.

## Launch requirement

For gstack's skills to resolve and run inside a headless agent, agents must be started with **`--dangerously-skip-permissions`** — `--permission-mode acceptEdits` isn't enough. AgentDeck sets this by default. Each agent is confined to its own git worktree on your own box, so the blast radius is that one task's branch; set `AGENTDECK_SKIP_PERMISSIONS=false` only for a supervised, hands-on debugging run.

### Don't run the daemon as root

**Claude Code refuses `--dangerously-skip-permissions` under uid 0.** A daemon running as root therefore fails every task in milliseconds, at spawn. AgentDeck detects this at boot: it logs an error, shows a red banner on the dashboard, reports `ok: false` from `GET /api/health`, and refuses to create new tasks rather than leaving you a trail of dead worktrees.

The fix is to run the daemon as an unprivileged user. Two supported shapes, depending on who you are when you install:

- **Installing as yourself** → a `systemd --user` unit plus `loginctl enable-linger`. Your account already has `claude`, gstack and credentials.
- **Installing as root** → a dedicated service account and a **system** unit with `User=`. [`scripts/setup-agent-user.sh`](scripts/setup-agent-user.sh) creates the account, its directories and the unit; the [install runbook](#install-with-claude-code-recommended) covers the parts that are decisions rather than commands — credentials, repo access, the deploy key. Run `--check` before you start the service: it audits what the *agent* needs (`claude`, credentials, gstack, `git`, an authenticated `gh`) as the service user, on the service PATH.

If it genuinely must run as root — no way to create a service account — `AGENTDECK_ALLOW_ROOT=true` makes agents carry `IS_SANDBOX=1`, which lifts Claude Code's root guard, and tasks run normally with gstack intact. It is a last resort, not the other half of a choice. Understand what you are trading:

- **The worktree argument above stops holding.** An agent running as root with permissions skipped can rewrite the systemd unit, read `~/.agentdeck/dashboard-token` and `agent-settings.json` (both `0600`, both readable by root), and touch every registered project. The blast radius is the box, not one branch.
- **`IS_SANDBOX` is an undocumented Claude Code internal**, not a supported flag, and it does more than lift the root guard. A future release can remove it. AgentDeck watches for that: if a task dies on the root refusal while `AGENTDECK_ALLOW_ROOT` is set, the banner is replaced with an error saying the escape hatch is gone, rather than continuing to claim it works.

### Migrating an existing root install

If you already run the daemon as root (with or without `AGENTDECK_ALLOW_ROOT`), this moves it onto a service account. The order matters more than any single step.

> **Drain first.** Let every in-flight task finish, and migrate only when nothing is `running` or `resuming`. Claude Code stores its transcripts under the daemon's `$HOME`, in a directory derived from each agent's cwd — so changing `HOME` makes every stored `sessionId` unresolvable. `claude --resume` then finds nothing, and the A2 durability that normally survives a restart loses those tasks **silently**.

1. `systemctl --user stop agentdeck && systemctl --user disable agentdeck` — before touching the SQLite file.
2. Create the account and give it what it needs: `sudo scripts/setup-agent-user.sh`, then `claude`, gstack and credentials for it (runbook steps 0b–2).
3. Move the data dir, so the database, worktrees and task rows come along. Step 2 already created an empty `/var/lib/agentdeck/.agentdeck`, and `mv` onto an existing directory would nest yours *inside* it — leaving the daemon with an empty database and every task apparently gone. Remove the empty one first; `rmdir` refuses if it isn't empty, which is the guard you want:
   ```
   rmdir /var/lib/agentdeck/.agentdeck
   mv ~/.agentdeck /var/lib/agentdeck/.agentdeck && chown -R agentdeck: /var/lib/agentdeck/.agentdeck
   ```
4. Give it the target repo (runbook step 4) — **including `git config --global --add safe.directory <repo>` for yourself**, or your own `git` starts refusing the repo you just handed over.
5. Write the new env file **without** `AGENTDECK_ALLOW_ROOT`; it has no reason to exist anymore.
6. `sudo scripts/setup-agent-user.sh --check`, then `systemctl daemon-reload && systemctl enable --now agentdeck`.
7. Archive the old `--user` unit instead of deleting it — a rollback is cheap while you still have it.
8. Verify: `/api/health` must report `uid` = the new account's, and an empty `notices`.

## Multiple projects (one daemon, many repos)

One daemon can drive several repos. Drop a **`projects.json`** in the data dir
(`~/.agentdeck` by default):

```json
[
  { "id": "api", "path": "/srv/billing-api", "label": "Billing API" },
  { "id": "web", "path": "/srv/web",
    "install": "npm ci",
    "preview": "npm run dev -- --port {port} --host 127.0.0.1" }
]
```

`id` is the routing key, `path` is the repo, `label` is what the dashboard shows
(defaults to the folder name). The header **Project** switcher filters the board
to one project or shows *All projects* (with a per-row tag); the choice is
remembered across reloads. Each task's branch/worktree lands in its project's
repo. Bad entries are skipped at boot with a warning; if there's no
`projects.json`, a single `default` project is synthesized from
`AGENTDECK_TARGET_REPO` — so existing single-repo setups keep working unchanged.
The optional `install`/`preview` commands power the Preview button; see
[Preview what an agent built](#preview-what-an-agent-built). A project without them
works exactly as before, minus that button.

## Preview what an agent built

A phase bar and a diff tell you an agent finished. They don't tell you whether the
thing *works*. **Preview** starts that task's dev server in its own worktree and
gives you a link.

Add an `install` and a `preview` command to the project in `projects.json`:

```json
[
  { "id": "web", "path": "/srv/web",
    "install": "npm ci",
    "preview": "npm run dev -- --port {port} --host 127.0.0.1 --strictPort" }
]
```

`{port}` is substituted with a port from the pool. Both fields also take an array
(`["npm","run","dev","--","--define","API=https://x/a b"]`) for arguments that
contain spaces — the string form splits on whitespace. Leading `NAME=VALUE` tokens
become environment for the child, which is how frameworks that ignore `--port` are
handled (`PORT={port} HOST=127.0.0.1 npm start`).

Then forward the pool alongside the dashboard:

```
ssh -L 8787:127.0.0.1:8787 \
    -L 8788:127.0.0.1:8788 -L 8789:127.0.0.1:8789 -L 8790:127.0.0.1:8790 user@vps
```

Already connected? `ssh -O forward -L 8788:127.0.0.1:8788 user@vps` adds a forward
to the session you have open instead of starting a second login.

**Why a separate port and not a path on 8787.** The previewed app is code an agent
just wrote and nobody reviewed. Served from the dashboard's own origin, its
JavaScript could read the dashboard token out of the page and drive the API —
creating tasks with `--dangerously-skip-permissions`. A different port is a
different origin, and everything the app needs (its own fetches, `localStorage`,
cookies, HMR) keeps working because within that origin it is still same-origin with
itself.

Things worth knowing before you rely on it:

- **`AGENTDECK_PREVIEW_PORTS` (default `8788-8790`) sets reachability *and*
  concurrency.** Each port needs its own forward, so the pool size is the number of
  simultaneous previews. Three dev servers is 0.6–1.8GB; on a 4GB box also running
  four agents, consider `8788-8789`.
- **Lock the pool down at the firewall.** Dev servers always bind `127.0.0.1`, but
  a belt-and-braces `ufw deny 8788:8790/tcp` costs nothing and covers any
  framework that ignores the bind flag you gave it.
- **Preview is offered only when the agent is idle** — waiting, done, stopped or
  errored. On a running task the button is disabled: a file-watcher pointed at a
  worktree being rewritten shows rebuild storms and half-finished builds, which
  look like bad work rather than work in progress.
- **Previews do not survive a daemon restart.** A dev server has no `--resume`
  handle, so the control simply returns to *Start*. A daemon killed with `-9`
  leaves its dev servers running; the next boot reaps them and frees the pool.
- **They stop themselves after `AGENTDECK_PREVIEW_TTL_MS`** (default 4h; `0`
  disables). This is a hard lifetime cap, not an idle timer — the daemon isn't in
  the request path, so it cannot tell whether you're looking.
- **If your *local* 8788 is already in use**, the link opens whatever is running
  there. A plausible wrong app is more confusing than a dead link, so check before
  trusting what you see.

Nothing starts on its own: previews are never auto-started on `done` or by the
pipeline, for the same reason `AGENTDECK_AUTO_CLEAN_MERGED` ships off.

## Upload files to the VPS

The dashboard's **Upload** button sends a local file to the box (no more manual
`scp`): it lands under `<dataDir>/uploads/<project>/` and the toast gives you the
absolute VPS path to reference in a task (with a copy button). Uploads — and every
other state-changing request (create/stop/delete/reply) — are gated by a
dashboard token (persisted 0600 in the data dir, injected into the served HTML,
sent as a header, so a cross-origin page can't forge them) and path-contained:
capped at 25 MB, filename sanitized, symlinked directories rejected, no writing
outside the target dir. The **live WebSocket is gated on the same token** (sent as
a subprotocol, never in the URL) plus an `Origin` check: WebSockets are not covered
by the same-origin policy, so without that gate any page you had open could read
the board. **Every route** — reads included — is also gated on a recognised `Host`
header: a hostile page whose domain resolves to `127.0.0.1` (DNS rebinding) reaches
the daemon from your own browser, and the reads are what it would harvest. Loopback
names are accepted on any port, so an `ssh -L 9000:127.0.0.1:8787` tunnel works
unchanged. Behind a reverse proxy, set `AGENTDECK_ALLOWED_HOSTS` to the hostname
your proxy sends, or the daemon rejects everything and says so at boot.

## QA with authenticated cookies on the VPS

The agent's browser on the VPS starts logged out, and gstack's cookie **capture**
is local-only (it decrypts your real Chrome via the OS keychain, impossible on a
headless server). But cookie **consumption** is portable, so:

1. **Locally**, log in once and save the state:
   `/setup-browser-cookies` (or a scripted login) → `$B state save qa` writes
   `.gstack/browse-states/qa.json` (a plain array of Playwright cookies).
2. **Upload** that JSON with the **Upload** button, ticking *QA browse-state* —
   it's placed at your project repo's `.gstack/browse-states/qa.json`.
3. **In the QA task**, the agent runs `$B state load qa` before the
   authenticated steps.

Alternative for a repeatable QA: a dedicated test account + scripted login, so
there are no cookies to transfer at all.

## Layout

```
src/        daemon: config, types, db (SQLite/WAL), git (worktrees), phase,
            agent (supervisor), notify, tasks, bus, server, daemon
public/     Master Inbox dashboard (live over WebSocket)
```

## License

[MIT](LICENSE) © 2026 Corenthin Buffard
