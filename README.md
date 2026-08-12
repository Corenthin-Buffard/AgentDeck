# AgentDeck

Self-hosted, **gstack-native** orchestrator for running multiple Claude Code agents in parallel on a VPS. An air-traffic-control board for your agents: one glance tells you which agent needs you, which is cruising, which broke.

`1 task = 1 branch = 1 git worktree = 1 agent.` Strict isolation, no sharing. Agents run on the server, so they keep going when you close your laptop or drop the SSH connection.

<p align="center">
  <img src="docs/demo.gif" width="820"
       alt="AgentDeck Master Inbox: several agents cruising, one flips to waiting, you reply in the drawer, and it resumes.">
</p>

<p align="center"><sub>One agent flips to <code>waiting</code>, you answer in the drawer, and it resumes — live over WebSocket.</sub></p>

> Status: **v0.2.4.1** — early but working end to end. The full loop runs with a real agent: create a task → branch → git worktree → the agent runs → it asks a question in prose → you reply from the dashboard → `claude --resume` continues → done, with the artifact on disk. Ships as a single self-contained binary (see **Install**). Not yet production-hardened.

## Why this and not Claude Squad / Conductor / amux

Those orchestrate agents generically. AgentDeck is coupled to the **gstack workflow**: it *drives* each agent through the `Plan → Run → Review → QA → Ship → Done` pipeline, one turn per step, and the board shows where each one is because the daemon is the thing that put it there. The human-in-loop moment is a first-class feature. Narrow on purpose — built for people who already run Claude Code + gstack.

## How it works

```
                     ┌──────────────────────────────────────────────┐
   Browser ──WS──────┼─▶ AgentDeck daemon (Bun, systemd --user)       │
   Slack/Telegram ◀──┼── notification-only (reply in the dashboard)   │
                     │   Agent supervisor: N × headless Claude Code    │
                     │   State store (SQLite, keyed by sessionId)      │
                     └───▲──────────────────────────────▲──────────────┘
                         │ HTTP hooks / SDK stream       │
              ┌──────────┴───┐                    ┌──────┴───────┐
              │ Agent 1       │  ...               │ Agent N      │
              │ cwd=worktree-1│                    │ cwd=worktree-N│
              └───────────────┘                    └──────────────┘
                 git worktree                         git worktree
```

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

Run this **in a Claude Code session on the machine where AgentDeck should live** (your VPS, not your laptop). Claude Code has shell access — paste the prompt and it installs gstack (if it's missing), downloads AgentDeck, asks for your target repo, and sets up a `systemd --user` service. It checks first whether gstack is already installed, is idempotent, and stops with a clear message if anything's off.

<details>
<summary><b>📋 Copy this prompt into Claude Code →</b></summary>

```text
Install AgentDeck (a self-hosted orchestrator for parallel Claude Code agents) and gstack (its required workflow toolkit) on THIS machine. Be idempotent, print each step, and STOP with a clear message if a prerequisite is missing or a check fails. Use absolute paths — do not assume PATH changes persist between your shell commands.

0. PREFLIGHT
- Detect OS/arch: `uname -s` / `uname -m`. Confirm `git` is present.
- If `bun` is not on PATH, install it (`curl -fsSL https://bun.sh/install | bash`) and then use the absolute path `$HOME/.bun/bin/bun` for the rest — a fresh shell may not have it on PATH.
- Remind me that `claude` (Claude Code) must be installed AND authenticated on THIS machine: the daemon spawns `claude` agents at runtime.

1. GSTACK — is it already installed? (yes / no)
- Run: `[ -f "$HOME/.claude/skills/gstack/VERSION" ] && echo "gstack INSTALLED $(cat "$HOME/.claude/skills/gstack/VERSION")" || echo "gstack NOT INSTALLED"`
- If INSTALLED: print the version, do NOT reinstall (I can run `/gstack-upgrade` later). Continue.
- If `$HOME/.claude/skills/gstack` exists but has NO `VERSION` file: it's a broken/partial install — STOP and ask me to inspect/remove it (do not clone over it).
- If NOT installed:
    git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$HOME/.claude/skills/gstack" && ( cd "$HOME/.claude/skills/gstack" && GSTACK_SKIP_FONTS=1 ./setup --no-prefix --no-plan-tune-hooks --quiet )
  Then verify: `[ -f "$HOME/.claude/skills/gstack/VERSION" ] && "$HOME/.claude/skills/gstack/bin/gstack-config" get telemetry` (both must succeed).

2. AGENTDECK — download the binary from Releases
- Pick the asset for this platform: Linux x86_64 -> agentdeck-linux-x64 ; Linux aarch64/arm64 -> agentdeck-linux-arm64 ; macOS arm64 -> agentdeck-darwin-arm64 ; anything else (Windows, Intel Mac) -> build from source (below).
- Download + install:
    mkdir -p "$HOME/.local/bin"
    curl -fsSL "https://github.com/Corenthin-Buffard/AgentDeck/releases/latest/download/<ASSET>" -o "$HOME/.local/bin/agentdeck"
    chmod +x "$HOME/.local/bin/agentdeck"
- VALIDATE the download before continuing: `file "$HOME/.local/bin/agentdeck"` must report an executable (ELF/Mach-O) and the file must be > 1 MB. If not (e.g. a 404 HTML page saved as the binary — is the repo public yet?), STOP with a clear message.
- Source fallback (no prebuilt binary for this platform): clone into a fresh dir (if `~/AgentDeck` already exists, `git -C ~/AgentDeck pull` instead of cloning), then `"$HOME/.bun/bin/bun" install && "$HOME/.bun/bin/bun" run build`, then `install -m 755 dist/agentdeck "$HOME/.local/bin/agentdeck"`.

3. CONFIG
- Ask me for AGENTDECK_TARGET_REPO — the ABSOLUTE path of the git repo the agents will work on. VALIDATE it is a git repo: `git -C "<path>" rev-parse --git-dir` — if not, STOP and ask me again.
- Optionally ask for notifications: AGENTDECK_SLACK_WEBHOOK, or AGENTDECK_TG_TOKEN + AGENTDECK_TG_CHAT.
- CHECK `id -u`. If it is **0**, you are installing as root, and Claude Code refuses `--dangerously-skip-permissions` under uid 0 — every task would fail at spawn. Tell me plainly, and offer the two real options: (a) re-run this install as an unprivileged user (recommended), or (b) set `AGENTDECK_ALLOW_ROOT=true`, which lets agents start but runs them AS ROOT with permissions skipped — the blast radius becomes the whole box, not one worktree. Do not pick for me. If I choose (b), include `AGENTDECK_ALLOW_ROOT=true` in the env file below.
- Write `$HOME/.config/agentdeck/env` in systemd EnvironmentFile format (one KEY=VALUE per line, no quoting/shell expansion; warn me if a value contains spaces, `%` or `#`). Include: AGENTDECK_HOST=127.0.0.1, AGENTDECK_PORT=8787, AGENTDECK_TARGET_REPO=<path>, AGENTDECK_ALLOW_ROOT (only if I chose it above), and any notification vars.

4. PERSISTENCE (systemd --user)
- First check systemd --user actually works here: `systemctl --user show-environment` (needs a user bus / XDG_RUNTIME_DIR). If it fails (bare VPS SSH session, minimal container) -> SKIP systemd, run AgentDeck in the background with the env file, and tell me plainly that persistence is NOT set up.
- Otherwise write `$HOME/.config/systemd/user/agentdeck.service` with REAL newlines, one directive per line:
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
  CRITICAL: the `Environment=PATH=` line MUST include wherever `claude` and `bun` live, or the daemon starts but CANNOT spawn agents. Bake the current `$PATH` into it, and confirm `command -v claude` resolves within that PATH BEFORE enabling.
  `RestartPreventExitStatus=78` matters: exit 78 means an unrecoverable config error (currently: the port is already bound). Without it, `Restart=on-failure` retries forever against a port that will still be busy.
- Run `loginctl enable-linger "$USER"` so the service survives logout/reboot. This may need root — if it fails, warn me that the service won't survive a full logout without it (do not claim it's persistent when it isn't).
- `systemctl --user daemon-reload && systemctl --user enable --now agentdeck`
- Verify with `GET /api/health`, NOT by grepping the page title. A misconfigured daemon serves a perfectly good dashboard while every task dies — "the page loads" is not evidence that anything works.
    systemctl --user is-active agentdeck          # must be: active
    curl -s http://127.0.0.1:8787/api/health      # must report "ok": true
  If `ok` is `false`, ask the daemon WHY — the diagnostic half is token-gated, because it reports the daemon's uid and the paths it reads:
    curl -s -H "x-agentdeck-token: $(cat "$HOME/.agentdeck/dashboard-token")" http://127.0.0.1:8787/api/health
  The `notices` array in that response says exactly what is wrong and what to do about it — read it back to me and STOP. Do NOT report a successful install. If port 8787 is already in use, the service exits 78 with a one-line reason; tell me (I can set a different AGENTDECK_PORT).

5. DONE — summarize: gstack version, agentdeck path, service status, `/api/health` ok plus any notices, whether the daemon is running as root and under which option, whether `claude` resolves in the service PATH, and the dashboard URL.
- Dashboard: http://127.0.0.1:8787 (localhost-bound). From my laptop I reach it via `ssh -L 8787:127.0.0.1:8787 user@vps` then http://localhost:8787.
```

</details>

Prereqs on the box: `claude` (authenticated), `git`, and `bun` (only for the source-build fallback). Not on Linux with `systemd --user`? The prompt still installs everything and runs the daemon — it just tells you persistence isn't wired up (set up `launchd`/a process manager yourself).

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

Run it under systemd `--user` to survive your laptop closing (that's the whole point — the daemon keeps the agents going while you're away).

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

Config knobs (env): `AGENTDECK_HOST` (default `127.0.0.1`), `AGENTDECK_PORT` (`8787`), `AGENTDECK_TARGET_REPO` (default: cwd — seeds the `default` project when there's no `projects.json`), `AGENTDECK_DATA_DIR` (default `~/.agentdeck` — SQLite DB + worktrees + uploads + `projects.json`), `AGENTDECK_WORKTREES`, `AGENTDECK_UPLOADS` (default `<dataDir>/uploads`), `AGENTDECK_MAX_AGENTS` (`4`), `AGENTDECK_PIPELINE` (off — ticks the gstack-pipeline box by default on new tasks; see [The gstack pipeline](#the-gstack-pipeline)), `AGENTDECK_CLAUDE_BIN` (`claude`), `AGENTDECK_REVIEW_READ_BIN` (gstack-review-read; resolved from PATH — the `[plan-reviews]` boot notice names it when missing), `AGENTDECK_SKIP_PERMISSIONS` (default on — `--dangerously-skip-permissions`; set `false` to disable), `AGENTDECK_ALLOW_ROOT` (off; `true` lets agents start when the daemon runs as root — see [Launch requirement](#launch-requirement)), `AGENTDECK_PERMISSION_MODE` (`acceptEdits`, used only when skip is off), `AGENTDECK_CLAUDE_ARGS`, `AGENTDECK_HOOKS` (opt-in Notification hooks, off by default), `AGENTDECK_HOOK_BASE_URL`, `AGENTDECK_HOOK_TOKEN` (per-session secret agents use for hooks), `AGENTDECK_DASHBOARD_TOKEN` (per-session secret the browser uses for writes/uploads — injected into the served HTML), `AGENTDECK_TG_TOKEN`/`AGENTDECK_TG_CHAT`, `AGENTDECK_SLACK_WEBHOOK`.

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

The fix is to run the daemon as an unprivileged user — `User=` in the systemd unit. That is the supported configuration.

If it genuinely must run as root, `AGENTDECK_ALLOW_ROOT=true` makes agents carry `IS_SANDBOX=1`, which lifts Claude Code's root guard, and tasks run normally with gstack intact. Understand what you are trading:

- **The worktree argument above stops holding.** An agent running as root with permissions skipped can rewrite the systemd unit, read `~/.agentdeck/dashboard-token` and `agent-settings.json` (both `0600`, both readable by root), and touch every registered project. The blast radius is the box, not one branch.
- **`IS_SANDBOX` is an undocumented Claude Code internal**, not a supported flag, and it does more than lift the root guard. A future release can remove it. AgentDeck watches for that: if a task dies on the root refusal while `AGENTDECK_ALLOW_ROOT` is set, the banner is replaced with an error saying the escape hatch is gone, rather than continuing to claim it works.

## Multiple projects (one daemon, many repos)

One daemon can drive several repos. Drop a **`projects.json`** in the data dir
(`~/.agentdeck` by default):

```json
[
  { "id": "api", "path": "/srv/billing-api", "label": "Billing API" },
  { "id": "web", "path": "/srv/web" }
]
```

`id` is the routing key, `path` is the repo, `label` is what the dashboard shows
(defaults to the folder name). The header **Project** switcher filters the board
to one project or shows *All projects* (with a per-row tag); the choice is
remembered across reloads. Each task's branch/worktree lands in its project's
repo. Bad entries are skipped at boot with a warning; if there's no
`projects.json`, a single `default` project is synthesized from
`AGENTDECK_TARGET_REPO` — so existing single-repo setups keep working unchanged.

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
