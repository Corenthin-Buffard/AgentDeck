#!/usr/bin/env bash
# End-to-end browser proof of the core loop with a REAL claude agent.
# Spins a throwaway target repo + a fresh daemon (temp data dir), drives the
# dashboard, and verifies the resumed agent wrote the artifact.
# Requires: bun, node, `claude` (authenticated), and this dir's deps
# (npm i + npx playwright install chromium). COSTS a real agent turn.
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

TMP="$(mktemp -d)"; TARGET="$TMP/target"; DATA="$TMP/data"
mkdir -p "$TARGET"
( cd "$TARGET" && git init -q && git config user.email e2e@test.local && git config user.name e2e \
  && printf '# e2e target\n' > README.md && git add -A && git commit -qm init && git branch -M main )

export AGENTDECK_TARGET_REPO="$TARGET" AGENTDECK_DATA_DIR="$DATA" AGENTDECK_PORT=8788
trap 'kill "${DPID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT

( cd "$REPO_ROOT" && bun run daemon ) > "$TMP/daemon.log" 2>&1 &
DPID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:8788/api/tasks" >/dev/null 2>&1 && break; sleep 0.3; done

RC=0; node browse-e2e.mjs || RC=$?

echo "--- artifact check ---"
COLOR="$(cat "$DATA"/worktrees/*/color.txt 2>/dev/null || true)"
echo "color.txt = '${COLOR}' (expected 'blue')"
[ "$COLOR" = "blue" ] || { echo "ARTIFACT MISMATCH"; exit 1; }
[ "$RC" = 0 ] && echo "E2E PASSED" || echo "E2E FAILED (rc=$RC)"
exit "$RC"
