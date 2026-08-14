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
AD_BIN_SET=0
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

# Captured BEFORE the parse loop shifts them away, so the "re-run with sudo" hints
# below can echo the invocation the operator actually typed.
ORIG_ARGS="$*"

while [ $# -gt 0 ]; do
  case "$1" in
    --user)  AD_USER="${2:?--user needs a value}"; shift 2 ;;
    --home)  AD_HOME="${2:?--home needs a value}"; shift 2 ;;
    --bin)   AD_BIN="${2:?--bin needs a value}"; AD_BIN_SET=1; shift 2 ;;
    --check) MODE="check"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

# An EXISTING account's home comes from passwd. /var/lib/<user> is only the default
# for one we are about to create — assuming it for an account that already exists
# points every check at a directory that isn't there, which is what happens in SELF
# mode where the account is you.
if [ -z "$AD_HOME" ]; then
  AD_HOME="$(getent passwd "$AD_USER" 2>/dev/null | cut -d: -f6)"
  : "${AD_HOME:=/var/lib/$AD_USER}"
fi

# SELF mode: the target account is the one running this. There is nobody to su to,
# the unit is a `systemd --user` one, and root is not required to look at your own
# install — see the guard in provision().
IS_SELF=0
[ "$(id -un)" = "$AD_USER" ] && IS_SELF=1

# Which SHAPE the install has is a different question from who is running this.
# Inspecting a dedicated install AS the service account is legitimate (and is how
# the unprivileged path gets tested), so infer the shape from what exists on disk
# and only fall back to IS_SELF for an install that does not exist yet.
UNIT_SYSTEM="/etc/systemd/system/${AD_USER}.service"
UNIT_USER="$AD_HOME/.config/systemd/user/agentdeck.service"
if   [ -f "$UNIT_SYSTEM" ]; then UNIT="$UNIT_SYSTEM"
elif [ -f "$UNIT_USER" ];   then UNIT="$UNIT_USER"
elif [ "$IS_SELF" -eq 1 ];  then UNIT="$UNIT_USER"
else                             UNIT="$UNIT_SYSTEM"
fi
ENV_FILE="$AD_HOME/.config/agentdeck/env"

# The PATH the service runs with. Every check below uses this exact string, so a
# tool that resolves here is a tool the daemon can actually spawn — checking with
# your own interactive PATH is how you certify an install that then fails.
#
# The two modes run with different PATHs, so the check has to follow. A SELF unit
# is written with your interactive PATH plus ~/.local/bin and ~/.bun/bin (that is
# what the runbook tells you to paste); probing the DEDICATED shape there reports
# a bun installed at its own default location as missing.
if [ "$IS_SELF" -eq 1 ]; then
  SERVICE_PATH="$PATH:$AD_HOME/.local/bin:$AD_HOME/.bun/bin"
else
  SERVICE_PATH="/usr/local/bin:/usr/bin:/bin:$AD_HOME/.local/bin"
fi

# Same story for the binary, and the same trap: a SELF install has no root so it
# lands in ~/.local/bin, but a DEDICATED install inspected BY the service account
# still has it in /usr/local/bin. Take whichever is actually there; only when
# neither exists does the mode decide what to recommend.
if [ "$AD_BIN_SET" -eq 0 ]; then
  if   [ -x "/usr/local/bin/agentdeck" ];        then AD_BIN="/usr/local/bin/agentdeck"
  elif [ -x "$AD_HOME/.local/bin/agentdeck" ];   then AD_BIN="$AD_HOME/.local/bin/agentdeck"
  elif [ "$IS_SELF" -eq 1 ];                     then AD_BIN="$AD_HOME/.local/bin/agentdeck"
  fi
fi

# ── preconditions ──────────────────────────────────────────────────────────────
# System accounts + a system-wide unit are Linux/systemd concepts. On macOS there
# is no useradd and the runbook's non-root path applies instead; say so rather
# than failing three commands later with something cryptic.
if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is Linux-only (it uses useradd and a systemd system unit)." >&2
  echo "On $(uname -s), run the daemon as your own user — see the README runbook." >&2
  exit 1
fi
# NOTE: the root requirement lives in provision(), not here. Creating a user and
# writing a system unit need root; INSPECTING an install does not, and making
# --check root-only left SELF-mode installs (where you are the service account)
# unable to open the very gate the runbook tells them to open.

# Run a command as the service account, with the service's HOME and PATH.
# `su -s` is needed because the account's shell is nologin, and neither HOME nor
# PATH survive on their own: su without `-` keeps root's HOME (a `curl | bash`
# installer will happily write into /root/.bun), and a non-interactive shell never
# sources .bashrc, so ~/.local/bin is absent unless we put it there.
# In SELF mode there is nobody to switch to, so this is a pass-through — same
# environment, no su, and no root needed.
run_as() {
  if [ "$IS_SELF" -eq 1 ]; then
    bash -c "export HOME='$AD_HOME' PATH='$SERVICE_PATH'; $1"
  else
    su -s /bin/bash "$AD_USER" -c "export HOME='$AD_HOME' PATH='$SERVICE_PATH'; $1"
  fi
}

# ── provision ──────────────────────────────────────────────────────────────────
provision() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Provisioning needs root (it creates a user and writes $UNIT): sudo $0 $ORIG_ARGS" >&2
    echo "Only --check runs unprivileged." >&2
    exit 1
  fi
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

Optional, if you will use the Preview button (see the README):
  - deny the dev-server pool at the firewall, e.g.  ufw deny 8788:8790/tcp
    Dev servers already bind 127.0.0.1 only; this is the belt-and-braces layer that
    also covers a framework which ignores the bind flag you gave it. NOT done for
    you: enabling a firewall you were not already running is how people lock
    themselves out of SSH.
EOF
}

# Preview dev servers run unreviewed, agent-written code. They bind loopback, so
# this is defence in depth rather than the only guard — hence a WARN, and only when
# ufw is the firewall actually in use. We cannot audit nftables rules or a cloud
# security group from here, and pretending otherwise would be worse than silence.
check_preview_firewall() {
  command -v ufw >/dev/null 2>&1 || return 0
  ufw status 2>/dev/null | head -1 | grep -qi 'Status: active' || return 0
  local ports="${AGENTDECK_PREVIEW_PORTS:-8788-8790}"
  if ufw status 2>/dev/null | grep -q "${ports%%-*}"; then
    ok "preview-firewall" "ufw has a rule covering $ports"
  else
    warn "preview-firewall" "ufw is active but has no rule for the preview pool ($ports) — add: ufw deny ${ports}/tcp"
  fi
}

# ── check ──────────────────────────────────────────────────────────────────────
FAILED=0   # the daemon cannot work
WARNED=0   # the daemon works, part of the workflow does not

ok()   { printf '  \033[32mOK\033[0m    %-22s %s\n' "$1" "${2-}"; }
warn() { printf '  \033[33mWARN\033[0m  %-22s %s\n' "$1" "${2-}"; WARNED=1; }
fail() { printf '  \033[31mFAIL\033[0m  %-22s %s\n' "$1" "${2-}"; FAILED=1; }

# Build a command the operator can PASTE, not a description of what to do. In SELF
# mode that is the bare command; otherwise the full `su -s` form WITH HOME and PATH,
# because dropping them is the exact trap that produced `claude: command not found`
# from a runbook line I had written myself.
as_paste() {
  if [ "$IS_SELF" -eq 1 ]; then printf '%s' "$1"
  else printf "su -s /bin/bash %s -c 'HOME=%s PATH=%s %s'" "$AD_USER" "$AD_HOME" "$SERVICE_PATH" "$1"; fi
}

check() {
  # Inspecting an account we are not requires root, because every probe below runs
  # as that account. Say so once, plainly, instead of letting every line fail with
  # su's own error.
  if [ "$IS_SELF" -ne 1 ] && [ "$(id -u)" -ne 0 ]; then
    echo "Checking $AD_USER's install needs root — every probe runs AS that account." >&2
    echo "Either:  sudo $0 $ORIG_ARGS" >&2
    echo "or run it as $AD_USER itself." >&2
    exit 1
  fi

  echo "AgentDeck install check — user $AD_USER, home $AD_HOME$([ "$IS_SELF" -eq 1 ] && echo '  (self)')"
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
        fail "target repo" "$AD_USER cannot write $repo/.git. Fix: chown -R $AD_USER: $repo  (then, for every other user of that repo: git config --global --add safe.directory $repo). Or clone it somewhere $AD_USER owns."
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

      # Writing the repo LOCALLY is not reaching it. The install that passed every
      # other line here still died on its first task with `Permission denied
      # (publickey)`, because the deploy key had never been registered.
      #
      # BatchMode is not decoration. --check runs from an interactive shell; the
      # daemon runs under systemd with NO tty, and StrictHostKeyChecking defaults to
      # `ask` (verified: `ssh -G` says so). Without it this probe can go green where
      # the daemon's push dies on `Host key verification failed`. Connect the way the
      # daemon will.
      local remote_url
      remote_url="$(run_as "git -C $qrepo config --get remote.origin.url" 2>/dev/null || true)"
      if [ -z "$remote_url" ]; then
        ok "remote" "no origin configured — local-only repo, nothing to reach"
      else
        local rout rrc host slug
        # Trailing `.git` only, never a greedy strip: the repo this was built against
        # is genuinely named `Samedi.`, so `Samedi..git` is correct and a clever
        # parse breaks it.
        slug="$(printf '%s' "$remote_url" | sed -e 's#^[a-z+]*://[^/]*/##' -e 's#^[^/]*:##' -e 's#\.git$##')"
        host="$(printf '%s' "$remote_url" | sed -e 's#^[a-z+]*://##' -e 's#^[^@]*@##' -e 's#[:/].*$##')"
        rrc=0
        rout="$(run_as "GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes' timeout 20 git -C $qrepo ls-remote origin 2>&1" 2>/dev/null)" || rrc=$?
        case "$rrc:$rout" in
          0:*)
            ok "remote" "$remote_url reachable as $AD_USER" ;;
          *"Host key verification failed"*)
            fail "remote" "$AD_USER has never accepted ${host:-the host}'s SSH key, and the daemon has no tty to accept it. Fix: $(as_paste "ssh-keyscan ${host:-HOST} >> ~/.ssh/known_hosts")" ;;
          *"Permission denied"*|*"could not read from remote"*|*"Could not read from remote"*)
            # git says "could not read from remote" for BOTH a refused key and a local
            # path that isn't there. Offering a deploy key for a missing directory is
            # nonsense advice — an empty host is what tells the two apart.
            if [ -z "$host" ]; then
              fail "remote" "$remote_url is unreachable — that path does not exist, or is not a git repository"
            elif printf '%s' "$slug" | grep -qE '^[^/]+/[^/]+$'; then
              fail "remote" "$AD_USER cannot authenticate to $remote_url — the deploy key is not registered. Fix: gh repo deploy-key add $AD_HOME/.ssh/id_ed25519.pub --repo $slug --title $AD_USER@$(hostname) --allow-write"
            else
              fail "remote" "$AD_USER cannot authenticate to $remote_url — register $AD_HOME/.ssh/id_ed25519.pub as a deploy key with write access on that repo"
            fi ;;
          124:*)
            warn "remote" "timed out after 20s reaching $remote_url — network, or a host that never answers. Not proven either way" ;;
          *)
            warn "remote" "could not reach $remote_url: $(printf '%s' "$rout" | tr '\n' ' ' | cut -c1-120)" ;;
        esac
      fi
    else
      fail "env" "$ENV_FILE has no AGENTDECK_TARGET_REPO — every create-task will 400. Fix: echo AGENTDECK_TARGET_REPO=/absolute/path/to/repo >> $ENV_FILE"
    fi
  else
    fail "env" "$ENV_FILE is missing — systemd will refuse to start the unit"
  fi

  # Named per-arch: a wrong asset downloads a 9-byte "Not Found" page that `chmod +x`
  # happily accepts, so the runbook's `file` check stays in the prose next to it.
  if [ -x "$AD_BIN" ]; then
    ok "binary" "$AD_BIN"
  else
    local asset; case "$(uname -m)" in
      x86_64)        asset="agentdeck-linux-x64" ;;
      aarch64|arm64) asset="agentdeck-linux-arm64" ;;
      *)             asset="agentdeck-linux-x64" ;;
    esac
    fail "binary" "$AD_BIN is missing or not executable. Fix: curl -fsSL https://github.com/Corenthin-Buffard/AgentDeck/releases/latest/download/$asset -o $AD_BIN && chmod +x $AD_BIN"
  fi

  # ── what the AGENT needs, not just the daemon ────────────────────────────────
  # Everything below is resolved with the SERVICE PATH as the service user. A tool
  # on your PATH but not on theirs is a tool the agent does not have.
  if run_as "command -v claude >/dev/null"; then
    ok "claude" "$(run_as 'command -v claude')"
  else
    fail "claude" "not on the service PATH — every agent fails at spawn. Fix: $(as_paste "curl -fsSL https://claude.ai/install.sh | bash")"
  fi

  # Its own credentials. Copied from yours or minted by `claude login` under this
  # account; either way, without them the agent authenticates against nothing.
  # Ask Claude Code itself instead of reverse-engineering ~/.claude/.credentials.json.
  # `claude auth status` is the vendor's own answer, and it catches the state a file
  # check cannot: credentials COPIED from another account keep looking like a perfect
  # file long after the OAuth refresh token has rotated out from under them, and then
  # every task dies at authentication while --check reports the file present. Measured
  # here — the copy was dead within hours and the daemon called the failed task done.
  local login_cmd authj
  # Pasteable, not "run claude auth login as X": under `su -s` there is no .bashrc, so
  # a PATH-less invocation dies with `claude: command not found` — the very trap the
  # RUN-AS convention warns about, which caught the author of this script.
  login_cmd="su -s /bin/bash $AD_USER -c 'HOME=$AD_HOME PATH=$SERVICE_PATH claude auth login'"
  authj="$(run_as "claude auth status 2>/dev/null" 2>/dev/null || true)"
  case "$authj" in
    *'"loggedIn":true'*|*'"loggedIn": true'*)
      ok "claude auth" "logged in" ;;
    *'"loggedIn"'*)
      fail "claude auth" "$AD_USER is NOT logged in — every task will fail at authentication. Fix: $login_cmd" ;;
    *)
      # Older claude, or one that cannot answer: fall back to the file, and say that
      # this is the weaker check rather than pretending it proves a working session.
      if run_as "test -s ~/.claude/.credentials.json"; then
        warn "claude auth" "'claude auth status' gave no verdict; ~/.claude/.credentials.json exists but was NOT proven usable"
      else
        fail "claude auth" "no credentials for $AD_USER — agents cannot authenticate. Fix: $login_cmd"
      fi ;;
  esac

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
    fail "gstack" "not installed for $AD_USER — skills will not resolve in agents. Fix: $(as_paste "git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && GSTACK_SKIP_FONTS=1 ./setup --no-prefix --no-plan-tune-hooks --quiet")"
  fi

  if run_as "command -v git >/dev/null"; then ok "git"; else fail "git" "not on the service PATH. Fix: apt-get install -y git"; fi

  # gh is how /ship opens a PR, and how AgentDeck's auto-clean proves a branch was
  # merged. Missing or unauthenticated, an agent does the whole task and then
  # falls over at the last step — so this is loud, but it does not stop the daemon.
  if run_as "command -v gh >/dev/null"; then
    if run_as "gh auth status >/dev/null 2>&1"; then
      ok "gh" "authenticated"
      # Breadth, not just presence. The classic device flow mints a token carrying
      # `repo` — write access to EVERY repo the account owns — which quietly undoes
      # the reason the deploy key was scoped to one. Measured on the install this
      # was built against: scopes were 'gist', 'read:org', 'repo'. A warning, not a
      # failure: a broad token works, it is only broader than what was decided.
      if run_as "gh auth status 2>&1" | grep -q "'repo'"; then
        warn "gh scope" "the token carries 'repo' — write access to ALL repos, wider than the deploy key. Prefer a fine-grained token limited to the target repo, set as GH_TOKEN in $ENV_FILE"
      fi
    else
      warn "gh" "installed but NOT authenticated — /ship will fail. Fix: $(as_paste "gh auth login")"
    fi
  else
    warn "gh" "not installed — /ship cannot open a PR and auto-clean can never prove a merge. Fix: apt-get install -y gh"
  fi

  # gstack's own setup needs all three (bunx for Playwright, node to launch it),
  # and most projects need at least one of them to run their tests.
  local t tfix
  for t in bun bunx node; do
    if run_as "command -v $t >/dev/null"; then ok "$t"; continue; fi
    case "$t" in
      # BOTH links, not just bun: gstack's setup calls bunx, and a bun-only symlink
      # fails it after several minutes of compiling.
      bun|bunx) tfix="$(as_paste "curl -fsSL https://bun.sh/install | bash && ln -sf ~/.bun/bin/bun ~/.bun/bin/bunx ~/.local/bin/")" ;;
      node)     tfix="apt-get install -y nodejs" ;;
    esac
    warn "$t" "not on the service PATH — gstack's setup needs it. Fix: $tfix"
  done

  check_preview_firewall

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
