#!/usr/bin/env bash
# Regenerate docs/demo.gif from the REAL dashboard. Requires: bun, node, and
# this dir's deps (npm i) + a chromium (npx playwright install chromium).
set -euo pipefail
cd "$(dirname "$0")"

DATA="$(mktemp -d)"
export AGENTDECK_DATA_DIR="$DATA" AGENTDECK_PORT=8790 DEMO_CTRL_PORT=9099 AGENTDECK_TARGET_REPO="$PWD"
trap 'kill "${DPID:-}" 2>/dev/null || true; rm -rf "$DATA"' EXIT

bun run driver.ts > "$DATA/driver.log" 2>&1 &
DPID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:8790/api/tasks" >/dev/null 2>&1 && break; sleep 0.3; done

node capture.mjs   # captures frames + fails on any dashboard JS error
node encode.mjs    # frames -> demo.gif (pure JS: gifenc + pngjs)
cp demo.gif ../demo.gif
echo "wrote ../demo.gif"

# Second artifact: the connection states, rendered narrow so the state label is
# legible at the README's display width. Takes ~30s — it really stops the daemon
# and waits out the give-up threshold and the backoff.
node capture-conn.mjs
node encode.mjs frames-conn demo-conn.gif
cp demo-conn.gif ../demo-conn.gif
echo "wrote ../demo-conn.gif"
