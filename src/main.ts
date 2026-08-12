import pkg from "../package.json" with { type: "json" };

// Process entry point. Its ONLY job is to answer --version/--help without booting
// anything, and then hand off to the daemon.
//
// Why this file exists at all: argv handling cannot live in daemon.ts. ESM
// evaluates a module's imports before its own body, and config.ts — which
// daemon.ts imports on line 2 — does real I/O at module scope: it mkdirSyncs the
// data dir and mints/persists the 0600 dashboard token. So an argv check written
// at the top of daemon.ts would already have created ~/.agentdeck and written a
// token file before it ran. `agentdeck --version` must not touch the disk, which
// means the check has to happen in a module that hasn't imported config yet —
// hence the dynamic import below.
//
// Keep this file dependency-free apart from package.json. Adding a static import
// of anything that reaches config.ts silently reintroduces the bug.

const argv = process.argv.slice(2);
const has = (...flags: string[]) => flags.some((f) => argv.includes(f));

const USAGE = `AgentDeck ${pkg.version} — self-hosted orchestrator for parallel Claude Code agents.

  agentdeck              start the daemon
  agentdeck --version    print the version and exit
  agentdeck --help       print this and exit

Configured entirely by environment (systemd: EnvironmentFile=):

  AGENTDECK_TARGET_REPO      repo to work on when there's no projects.json
  AGENTDECK_DATA_DIR         state dir (default ~/.agentdeck)
  AGENTDECK_HOST             bind address (default 127.0.0.1 — reach it via SSH tunnel)
  AGENTDECK_PORT             bind port (default 8787)
  AGENTDECK_ALLOWED_HOSTS    extra Host header names, comma-separated (reverse proxy)
  AGENTDECK_CLAUDE_BIN       path to \`claude\` (default: resolved from PATH)
  AGENTDECK_MAX_AGENTS       concurrent agent cap (default 4)
  AGENTDECK_SKIP_PERMISSIONS "false" disables --dangerously-skip-permissions.
                             gstack skills only resolve with it ON, which is the default.
  AGENTDECK_ALLOW_ROOT       "true" lets agents start when the daemon runs as root, by
                             passing IS_SANDBOX=1 to lift Claude Code's root guard.
                             Agents then run AS ROOT with permissions skipped. Prefer
                             running the daemon as an unprivileged user.
  AGENTDECK_PERMISSION_MODE  used only when SKIP_PERMISSIONS=false (default acceptEdits)
  AGENTDECK_CLAUDE_ARGS      extra flags passed to every agent (--model, --add-dir, …)
  AGENTDECK_AUTO_CLEAN_MERGED  "true" to drop merged done tasks periodically
  AGENTDECK_HOOKS            "true" to wire the Notification/PreToolUse hooks
  AGENTDECK_TG_TOKEN + AGENTDECK_TG_CHAT   Telegram notifications
  AGENTDECK_SLACK_WEBHOOK    Slack notifications

Health: GET /api/health reports {ok, version, uid, notices} — ok is false when a
config problem means tasks cannot run. Use it to verify an install.`;

if (has("--version", "-v")) {
  console.log(pkg.version);
} else if (has("--help", "-h")) {
  console.log(USAGE);
} else {
  // Dynamic: this is the first thing that pulls in config.ts and its side effects.
  await import("./daemon.ts");
}
