#!/usr/bin/env bash
# End-to-end browser proof of the core loop with a REAL claude agent.
# Spins a throwaway target repo + a fresh daemon (temp data dir), drives the
# dashboard, and verifies the resumed agent wrote the artifact.
# Requires: bun, node, `claude` (authenticated), and this dir's deps
# (npm i + npx playwright install chromium). COSTS a real agent turn.
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
PORT=8788
LOG="$PWD/daemon.log"   # local (gitignored) so it survives cleanup for diagnosis

# Fail clearly if the port is already held (a stale/foreign daemon), instead of
# silently EADDRINUSE-ing and driving the wrong daemon.
if curl -sf "http://127.0.0.1:$PORT/api/tasks" >/dev/null 2>&1; then
  echo "port $PORT is already in use — stop the other daemon first"; exit 1
fi

TMP="$(mktemp -d)"; TARGET="$TMP/target"; DATA="$TMP/data"
mkdir -p "$TARGET"
( cd "$TARGET" && git init -q && git config user.email e2e@test.local && git config user.name e2e \
  && printf '# e2e target\n' > README.md && git add -A && git commit -qm init && git branch -M main )

export AGENTDECK_TARGET_REPO="$TARGET" AGENTDECK_DATA_DIR="$DATA" AGENTDECK_PORT="$PORT"
# Kill the daemon's whole process group on exit, so a mid-run failure/timeout
# can't leave an orphaned `claude` agent burning tokens against a deleted worktree.
cleanup() { [ -n "${DPID:-}" ] && kill -- -"$DPID" 2>/dev/null || true; rm -rf "${TMP:-/nonexistent-xyz}"; }
trap cleanup EXIT

set -m   # job control: the background daemon gets its own process group (PGID = DPID)
( cd "$REPO_ROOT" && exec bun run daemon ) > "$LOG" 2>&1 &
DPID=$!
set +m
for _ in $(seq 1 40); do
  kill -0 "$DPID" 2>/dev/null || { echo "daemon exited early — see $LOG"; exit 1; }
  curl -sf "http://127.0.0.1:$PORT/api/tasks" >/dev/null 2>&1 && break
  sleep 0.3
done

RC=0; node browse-e2e.mjs || RC=$?

echo "--- artifact check ---"
COLOR="$(cat "$DATA"/worktrees/*/color.txt 2>/dev/null || true)"
echo "color.txt = '${COLOR}' (expected 'blue')"
[ "$COLOR" = "blue" ] || { echo "ARTIFACT MISMATCH (daemon log: $LOG)"; exit 1; }
[ "$RC" = 0 ] && echo "E2E PASSED" || echo "E2E FAILED (rc=$RC, daemon log: $LOG)"
exit "$RC"
