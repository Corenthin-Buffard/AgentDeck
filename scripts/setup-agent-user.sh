#!/usr/bin/env bash
# Create the unprivileged user AgentDeck's daemon (and therefore every agent)
# runs as, and install the systemd unit for it.
#
# WHY THIS EXISTS: Claude Code refuses --dangerously-skip-permissions under uid 0,
# so a root daemon fails every task at spawn. The fix is not a flag, it's an
# identity — and creating that identity by hand is a dozen steps where getting one
# wrong leaves a daemon that boots fine and dies on first contact.
#
# This script owns ONLY the mechanical half. Credentials, the target repo and the
# SSH deploy key are human decisions and stay in the README runbook.
#
# It deliberately does NOT enable or start the service: without credentials and a
# repo the daemon would come up and fail, which is exactly the confusing state
# this whole change exists to prevent. Run --check first, then enable --now.
#
# This file is the single source of truth for the unit's contents — the README
# shows the invocation, never a copy of the unit, because two copies diverge.

set -euo pipefail

AD_USER="agentdeck"
AD_HOME=""
AD_BIN="/usr/local/bin/agentdeck"
MODE="provision"

usage() {
  cat <<'EOF'
Usage: setup-agent-user.sh [options]

  --user NAME     service account to create        (default: agentdeck)
  --home PATH     its home directory               (default: /var/lib/<user>)
  --bin PATH      where the agentdeck binary lives (default: /usr/local/bin/agentdeck)
  --check         audit an existing install; change nothing
  -h, --help      this text

Provision mode creates the user, its directories and /etc/systemd/system/<user>.service,
then reloads systemd. It does NOT enable or start the service.

Check mode exits 0 when the daemon can work AND agents can ship, 2 when the daemon
can work but part of the workflow cannot, and 1 when something is outright broken.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user)  AD_USER="${2:?--user needs a value}"; shift 2 ;;
    --home)  AD_HOME="${2:?--home needs a value}"; shift 2 ;;
    --bin)   AD_BIN="${2:?--bin needs a value}";  shift 2 ;;
    --check) MODE="check"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

: "${AD_HOME:=/var/lib/$AD_USER}"
UNIT="/etc/systemd/system/${AD_USER}.service"
ENV_FILE="$AD_HOME/.config/agentdeck/env"

# The PATH the service runs with. Every check below uses this exact string, so a
# tool that resolves here is a tool the daemon can actually spawn — checking with
# your own interactive PATH is how you certify an install that then fails.
SERVICE_PATH="/usr/local/bin:/usr/bin:/bin:$AD_HOME/.local/bin"

# ── preconditions ──────────────────────────────────────────────────────────────
# System accounts + a system-wide unit are Linux/systemd concepts. On macOS there
# is no useradd and the runbook's non-root path applies instead; say so rather
# than failing three commands later with something cryptic.
if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is Linux-only (it uses useradd and a systemd system unit)." >&2
  echo "On $(uname -s), run the daemon as your own user — see the README runbook." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (creating a user and writing $UNIT both need it): sudo $0 $*" >&2
  exit 1
fi

# Run a command as the service account, with the service's HOME and PATH.
# `su -s` is needed because the account's shell is nologin, and neither HOME nor
# PATH survive on their own: su without `-` keeps root's HOME (a `curl | bash`
# installer will happily write into /root/.bun), and a non-interactive shell never
# sources .bashrc, so ~/.local/bin is absent unless we put it there.
run_as() { su -s /bin/bash "$AD_USER" -c "export HOME='$AD_HOME' PATH='$SERVICE_PATH'; $1"; }

# ── provision ──────────────────────────────────────────────────────────────────
provision() {
  if id "$AD_USER" >/dev/null 2>&1; then
    echo "user      $AD_USER exists (uid $(id -u "$AD_USER"))"
  else
    # nologin on purpose: nothing should be able to log in as the agent account.
    # Every setup step goes through `su -s /bin/bash`, which works regardless.
    local shell="/usr/sbin/nologin"
    [ -x "$shell" ] || shell="/sbin/nologin"
    useradd --system --create-home --home-dir "$AD_HOME" --shell "$shell" "$AD_USER"
    echo "user      $AD_USER created (uid $(id -u "$AD_USER"))"
  fi

  # ~/.agentdeck is the data dir (SQLite + worktrees + uploads); ~/.local/bin is
  # on the service PATH, so per-user tools installed later land somewhere the
  # daemon can actually see.
  local d
  for d in "$AD_HOME/.config/agentdeck" "$AD_HOME/.local/bin" "$AD_HOME/.agentdeck"; do
    mkdir -p "$d"
  done
  chown -R "$AD_USER:$AD_USER" "$AD_HOME/.config" "$AD_HOME/.local" "$AD_HOME/.agentdeck"
  echo "dirs      $AD_HOME/{.config/agentdeck,.local/bin,.agentdeck}"

  # systemd refuses to start a unit whose EnvironmentFile is missing, so seed one.
  # Empty but present beats absent: the operator fills it in, and --check tells
  # them it still has no target repo.
  if [ ! -f "$ENV_FILE" ]; then
    # umask BEFORE the create, not chmod after: the operator pastes API tokens and
    # webhook URLs into this file, and a create-then-chmod leaves a world-readable
    # window. Same reason daemon.ts rm+creates agent-settings.json at 0600.
    ( umask 077; cat > "$ENV_FILE" <<EOF
# AgentDeck config, systemd EnvironmentFile format: one KEY=VALUE per line,
# no quoting and no shell expansion. Fill in AGENTDECK_TARGET_REPO before starting.
AGENTDECK_HOST=127.0.0.1
AGENTDECK_PORT=8787
#AGENTDECK_TARGET_REPO=/absolute/path/to/repo
EOF
    )
    chown "$AD_USER:$AD_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"  # belt and braces: umask above already made it 0600
    echo "env       $ENV_FILE seeded (fill in AGENTDECK_TARGET_REPO)"
  else
    echo "env       $ENV_FILE exists, left alone"
  fi

  # RestartPreventExitStatus=78: exit 78 is an unrecoverable config error (today,
  # a port already bound). Without it Restart=on-failure retries forever against a
  # port that will still be busy.
  # No loginctl enable-linger and no user bus: a system service has neither, which
  # is precisely why this is a system unit and not a `systemd --user` one.
  cat > "$UNIT" <<EOF
[Unit]
Description=AgentDeck daemon
After=network.target

[Service]
User=$AD_USER
Group=$AD_USER
ExecStart=$AD_BIN
EnvironmentFile=$ENV_FILE
Environment=HOME=$AD_HOME
Environment=PATH=$SERVICE_PATH
Restart=on-failure
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT"
  echo "unit      $UNIT"

  # Non-fatal: containers and CI runners often have no running systemd. The unit
  # is still written correctly, and a machine without systemd was never going to
  # start it anyway.
  if command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload 2>/dev/null; then
    echo "systemd   daemon-reload done"
  else
    echo "systemd   daemon-reload skipped (no running systemd here)"
  fi

  cat <<EOF

Next, from the README runbook — none of it is mechanical, so none of it is here:
  1. install claude and gstack FOR $AD_USER (its own copies, not links into /root)
  2. give it Claude Code credentials
  3. give it access to the target repo, and set AGENTDECK_TARGET_REPO in $ENV_FILE
  4. install the agentdeck binary at $AD_BIN
  5. $0 --check      # must pass BEFORE the next line
  6. systemctl enable --now $AD_USER
EOF
}

# ── check ──────────────────────────────────────────────────────────────────────
FAILED=0   # the daemon cannot work
WARNED=0   # the daemon works, part of the workflow does not

ok()   { printf '  \033[32mOK\033[0m    %-22s %s\n' "$1" "${2-}"; }
warn() { printf '  \033[33mWARN\033[0m  %-22s %s\n' "$1" "${2-}"; WARNED=1; }
fail() { printf '  \033[31mFAIL\033[0m  %-22s %s\n' "$1" "${2-}"; FAILED=1; }

check() {
  echo "AgentDeck install check — user $AD_USER, home $AD_HOME"
  echo

  if id "$AD_USER" >/dev/null 2>&1; then
    ok "user" "$AD_USER, uid $(id -u "$AD_USER")"
  else
    fail "user" "$AD_USER does not exist — run this script without --check"
    return 1
  fi

  if [ -d "$AD_HOME" ]; then ok "home" "$AD_HOME"; else fail "home" "$AD_HOME is missing"; fi

  # A home the service account does not fully OWN is the quiet killer. The daemon
  # only reads most of it, so every check above stays green and the dashboard looks
  # healthy — until an agent WRITES. Observed here: `.config` was left root-owned by
  # a hand-built install, and `gh auth login` died on `mkdir: permission denied`
  # while everything else reported fine. Any `sudo mkdir` in someone's home
  # recreates it, so check the whole top level rather than the dirs we happen to
  # create.
  if [ -d "$AD_HOME" ]; then
    local foreign
    foreign="$(find "$AD_HOME" -maxdepth 1 -mindepth 1 ! -user "$AD_USER" -printf '%p ' 2>/dev/null)"
    if [ -z "$foreign" ]; then
      ok "home ownership" "everything directly under $AD_HOME belongs to $AD_USER"
    else
      fail "home ownership" "$AD_USER does not own: ${foreign% } — fix with: chown -R $AD_USER: ${foreign% }"
    fi
  fi

  if [ -f "$UNIT" ]; then
    if command -v systemd-analyze >/dev/null 2>&1 && ! systemd-analyze verify "$UNIT" 2>&1 | grep -q .; then
      ok "unit" "$UNIT (verified)"
    else
      ok "unit" "$UNIT"
    fi
  else
    fail "unit" "$UNIT is missing"
  fi

  # A daemon with no target repo serves a perfectly good dashboard and 400s every
  # create-task, which reads as "the install worked" until you use it.
  if [ -f "$ENV_FILE" ]; then
    if grep -qE '^AGENTDECK_TARGET_REPO=..*' "$ENV_FILE"; then
      local repo; repo="$(grep -E '^AGENTDECK_TARGET_REPO=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
      ok "env" "$ENV_FILE"
      # run_as interpolates into a shell string, so the path must be quoted for the
      # shell, not just wrapped in quotes here: a lone ' in the value escapes the
      # quoting and the check can report OK on a path that does not exist. Verified
      # with AGENTDECK_TARGET_REPO="/nope' || true || '". printf %q makes it inert.
      # This value is agent-writable (the env file belongs to the service account,
      # and agents run as it), and this check is the gate the runbook trusts.
      local qrepo; qrepo="$(printf '%q' "$repo")"
      if run_as "test -d $qrepo/.git && test -w $qrepo/.git" 2>/dev/null; then
        ok "target repo" "$repo (writable by $AD_USER)"
      else
        fail "target repo" "$AD_USER cannot write $repo/.git — chown it, or clone to a neutral path"
      fi
      # Separate from the test above ON PURPOSE: a 0700 parent (/root is the usual
      # culprit) makes the repo unreachable even when its own mode is fine, and the
      # two failures need different fixes.
      local parent; parent="$(dirname "$repo")"
      if run_as "test -x $(printf '%q' "$parent")" 2>/dev/null; then
        ok "repo parent" "$parent is traversable"
      else
        fail "repo parent" "$AD_USER cannot traverse $parent (mode $(stat -c '%a' "$parent" 2>/dev/null || echo '?')) — move the repo rather than opening it up"
      fi
    else
      fail "env" "$ENV_FILE has no AGENTDECK_TARGET_REPO — every create-task will 400"
    fi
  else
    fail "env" "$ENV_FILE is missing — systemd will refuse to start the unit"
  fi

  if [ -x "$AD_BIN" ]; then ok "binary" "$AD_BIN"; else fail "binary" "$AD_BIN is missing or not executable"; fi

  # ── what the AGENT needs, not just the daemon ────────────────────────────────
  # Everything below is resolved with the SERVICE PATH as the service user. A tool
  # on your PATH but not on theirs is a tool the agent does not have.
  if run_as "command -v claude >/dev/null"; then
    ok "claude" "$(run_as 'command -v claude')"
  else
    fail "claude" "not on the service PATH — every agent fails at spawn"
  fi

  # Its own credentials. Copied from yours or minted by `claude login` under this
  # account; either way, without them the agent authenticates against nothing.
  if run_as "test -s ~/.claude/.credentials.json"; then
    # PRESENT is not USABLE, and the difference is the trap in copied credentials:
    # the OAuth refresh token ROTATES, so a file copied from your own account works
    # only until YOUR session refreshes — after that the agent's copy is dead and
    # every task fails at authentication. Seen here hours after the copy, with the
    # daemon reporting the failed task as done.
    # The grep runs INSIDE run_as so the token itself never crosses back out.
    local exp now
    exp="$(run_as "grep -o '\"expiresAt\":[0-9]*' ~/.claude/.credentials.json | head -1 | cut -d: -f2" 2>/dev/null || echo "")"
    now="$(( $(date +%s) * 1000 ))"
    if [ -z "$exp" ] || [ "$exp" = "0" ]; then
      fail "claude creds" "$AD_HOME/.claude/.credentials.json has no usable expiry — likely a stale copy. Run 'claude login' as $AD_USER"
    elif [ "$exp" -lt "$now" ] 2>/dev/null; then
      fail "claude creds" "expired at $(date -u -d "@$((exp/1000))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$exp") — run 'claude login' as $AD_USER"
    else
      ok "claude creds" "valid until $(date -u -d "@$((exp/1000))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$exp")"
    fi
  else
    fail "claude creds" "no ~/.claude/.credentials.json for $AD_USER — agents cannot authenticate"
  fi

  if run_as "test -f ~/.claude/skills/gstack/VERSION"; then
    ok "gstack" "$(run_as 'cat ~/.claude/skills/gstack/VERSION')"
    # Same resolution order as the daemon (src/config.ts): PATH first, then the
    # stock location. Checking only PATH would report a false failure, because
    # gstack installs with --no-prefix by default.
    if run_as "command -v gstack-review-read >/dev/null || test -x ~/.claude/skills/gstack/bin/gstack-review-read"; then
      ok "gstack-review-read" "plan-review tracking will work"
    else
      warn "gstack-review-read" "missing — the plan-review marks stay ○"
    fi
  else
    fail "gstack" "not installed for $AD_USER — skills will not resolve in agents"
  fi

  if run_as "command -v git >/dev/null"; then ok "git"; else fail "git" "not on the service PATH"; fi

  # gh is how /ship opens a PR, and how AgentDeck's auto-clean proves a branch was
  # merged. Missing or unauthenticated, an agent does the whole task and then
  # falls over at the last step — so this is loud, but it does not stop the daemon.
  if run_as "command -v gh >/dev/null"; then
    if run_as "gh auth status >/dev/null 2>&1"; then
      ok "gh" "authenticated"
    else
      warn "gh" "installed but NOT authenticated — /ship will fail; run: su -s /bin/bash $AD_USER -c 'HOME=$AD_HOME gh auth login'"
    fi
  else
    warn "gh" "not installed — /ship cannot open a PR and auto-clean can never prove a merge"
  fi

  # gstack's own setup needs all three (bunx for Playwright, node to launch it),
  # and most projects need at least one of them to run their tests.
  local t
  for t in bun bunx node; do
    if run_as "command -v $t >/dev/null"; then ok "$t"; else warn "$t" "not on the service PATH"; fi
  done

  echo
  if [ "$FAILED" -ne 0 ]; then
    echo "FAIL — do not start the daemon yet; fix the lines above."
    return 1
  elif [ "$WARNED" -ne 0 ]; then
    echo "OK with warnings — the daemon will run, but the flagged parts of the workflow will not."
    return 2
  fi
  echo "OK — the daemon can run and agents can ship."
  return 0
}

case "$MODE" in
  provision) provision ;;
  check)     check ;;
esac
