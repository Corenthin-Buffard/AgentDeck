import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { config, rootBlocksAgents, rootWillBlockAgents, ROOT_BLOCKED_MESSAGE } from "./config.ts";
import { store } from "./db.ts";
import { resumeTask } from "./agent.ts";
import { startServer, isLoopbackBind } from "./server.ts";
import { startAutoCleanSweep } from "./cleanup.ts";
import { hookSettings } from "./hooks-config.ts";
import { notice } from "./notices.ts";
import { installPreviewShutdown, reapOrphans, startPreviewSweep } from "./preview.ts";

// AgentDeck daemon boot. Runs as a systemd service on the VPS — as a SYSTEM unit
// under a dedicated unprivileged user when you install as root (the supported
// shape; see scripts/setup-agent-user.sh), or as a `systemd --user` unit when you
// install as yourself. Either way it lives on the server, so agents survive
// SSH/browser disconnects — they run here, not on your laptop.
//
// NOTE: this is NOT the process entry point — src/main.ts is, because it must
// handle --version/--help BEFORE config.ts is imported (config.ts does real I/O
// at module scope: it mkdirSyncs the data dir and mints the dashboard token).
//
// Everything below that detects a problem calls notice() rather than console.warn,
// so the dashboard can show it too. Same text in the log; see notices.ts.

// We now RELAY agent stderr through our own stdio (see attach() in agent.ts), so
// a dead log reader is our problem rather than the child's. A broken pipe surfaces
// asynchronously as an 'error' EVENT on the stream — a try/catch around write()
// cannot see it — and with no listener that becomes an uncaughtException that
// kills the daemon and every running agent with it. Anyone piping us (`agentdeck
// 2>&1 | tee log`, `| logger`, a supervisor whose reader restarts) would otherwise
// have a one-EPIPE kill switch on the whole fleet. Degrade to silence instead.
process.stderr.on("error", () => { /* the log sink went away; keep running */ });
process.stdout.on("error", () => { /* ditto */ });

// Running as root is the one condition that makes the daemon useless rather than
// degraded, so it's the first thing in the log. Three distinct cases:
//   uid 0 + skip-permissions + no opt-in -> nothing can run at all (error)
//   uid 0 + opt-in                       -> everything runs, as root (warn)
//   uid 0 + permissions not skipped      -> runs, but writes root-owned files (warn)
const uid = process.getuid?.();
if (uid === 0) {
  if (rootBlocksAgents(uid)) {
    notice("error", "root", ROOT_BLOCKED_MESSAGE);
  } else if (config.allowRoot && config.dangerouslySkipPermissions) {
    // State the FACT, never a claim like "bypass active" — IS_SANDBOX is an
    // undocumented Claude Code internal, and agent.ts retracts this notice if a
    // task later proves the guard is still refusing.
    notice("warn", "root", "running as root with AGENTDECK_ALLOW_ROOT=true — agents are spawned with IS_SANDBOX=1, which lifts Claude Code's root guard. Every agent runs as root with permissions skipped, so the blast radius is the whole box, not one worktree.");
  } else {
    notice("warn", "root", "running as root — every agent, and everything it writes into a worktree, is owned by root. Run the daemon as an unprivileged user (systemd: User=).");
  }
}

// Agents are spawned by name, and a systemd unit's PATH is not your login shell's
// — a missing `claude` is the single most common install mistake. Catch it once at
// boot rather than once per task: with Restart=on-failure plus the A2 resume loop
// below, a spawn failure that reaches the supervisor is a restart loop, not one
// dead task. Same shape as the reviewReadBin check further down.
if (!Bun.which(config.claudeBin)) {
  notice("error", "claude-bin", `'${config.claudeBin}' is not on PATH — every agent will fail to start. Set AGENTDECK_CLAUDE_BIN to its absolute path, or add it to the service PATH (systemd: Environment=PATH=…).`);
}

mkdirSync(config.worktreesDir, { recursive: true });
mkdirSync(config.uploadsDir, { recursive: true });

// Boot-validate the project registry: drop any path that isn't a git repo so a
// typo'd projects.json never silently routes a task into the wrong (or no) repo.
// Runs here (not at config import) to keep config.ts pure and off the test path.
config.projects = config.projects.filter((p) => {
  const r = Bun.spawnSync(["git", "-C", p.path, "rev-parse", "--git-dir"]);
  if (r.exitCode !== 0) { notice("warn", "projects", `'${p.id}' is not a git repo, skipping: ${p.path}`); return false; }
  return true;
});
if (!config.projects.length) {
  notice("error", "projects-empty", "no valid project — create-task will 400 until projects.json points at a git repo");
}

// Plan-review tracking reads a branch's gstack review log via this binary. If it's
// not where we resolved it, log ONCE at boot so "the CEO/Design/Eng marks never
// tick" is an explained degradation, not a silent mystery. Not fatal — the marks
// just stay ○ and everything else runs.
if (!existsSync(config.reviewReadBin)) {
  notice("warn", "plan-reviews", `gstack-review-read not found (${config.reviewReadBin}) — review tracking disabled (set AGENTDECK_REVIEW_READ_BIN)`);
}

// Bound off-loopback with no allowlist. Loopback Hosts still work, so this is
// not "nothing works" — but a browser reaching the box by its LAN/public address
// or through a proxy sends THAT hostname, and the rebinding gate rejects it. Say
// so at boot rather than leaving the operator to debug selective 403s.
if (!isLoopbackBind(config.host) && !config.allowedHosts.length) {
  notice("warn", "host-gate", `bound to ${config.host} with an empty AGENTDECK_ALLOWED_HOSTS — only loopback Hosts (localhost, 127.x.x.x, [::1]) are accepted. Requests carrying any other Host are rejected; set AGENTDECK_ALLOWED_HOSTS=your.domain to allow them.`);
}

// Write the settings file that agents load via `claude --settings` so Claude
// Code POSTs Notification/PreToolUse hook events back to us. Written before we
// resume any in-flight agent below.
if (config.notificationHooks) {
  try {
    // Remove any pre-existing (possibly loose-perm, e.g. 0644 from an older build)
    // file first so the fresh create honors 0600 — writeFileSync's `mode` is
    // ignored when the file already exists, which would leak the token for the
    // write→chmod window. chmod stays as a belt-and-suspenders final state.
    rmSync(config.agentSettingsPath, { force: true });
    writeFileSync(config.agentSettingsPath, JSON.stringify(hookSettings(config.hookBaseUrl, config.hookToken), null, 2), { mode: 0o600 });
    chmodSync(config.agentSettingsPath, 0o600);
    console.log(`[hooks] agents POST Notification/PreToolUse → ${config.hookBaseUrl}`);
  } catch (e) {
    config.notificationHooks = false; // degrade — never crash the daemon over an optional enhancement
    notice("warn", "hooks", `disabled: could not write ${config.agentSettingsPath}: ${(e as Error).message}`);
  }
}

// ── Preview boot checks ─────────────────────────────────────────────────────
// These run BEFORE startServer() for one specific reason: startServer() bakes
// `config.preview.enabled` into the served HTML as a meta tag, once, at call time.
// Deciding afterwards left the dashboard advertising a feature the daemon had just
// switched off — the button rendered, every click 409'd, and the message named
// AGENTDECK_PREVIEW=false when the real cause was a port collision.
//
// Safe to run first because none of it has side effects outside this process: it
// only reads config, sets a flag, raises notices, arms two timers and registers the
// signal handlers. The one part that DOES touch the box — reaping another daemon's
// leftover children — deliberately waits until after the port bind, below.
//
// All of it is non-fatal by construction: a preview problem must never stop the
// daemon from running agents, which is its actual job.
if (config.preview.enabled) {
  // A pool port that collides with the dashboard would put an agent-written app on
  // the SAME ORIGIN as the dashboard, where its JavaScript could read the token out
  // of the served HTML and drive the API. Refuse rather than warn.
  if (config.preview.ports.includes(config.port)) {
    config.preview.enabled = false;
    notice("error", "preview-port", `AGENTDECK_PREVIEW_PORTS includes the dashboard port (${config.port}), which would serve agent-written code on the dashboard's own origin — previews are disabled. Choose a different pool.`);
  } else if (!isLoopbackBind(config.host)) {
    // Previews are reached by opening http://<this host>:<pool port> from the
    // browser, which only works over the SSH tunnel. Behind a reverse proxy the
    // link would point at a port nothing is serving on the public name, so the
    // button would render and then fail. Say so instead.
    config.preview.enabled = false;
    notice("warn", "preview-host", `the daemon is bound to ${config.host} rather than loopback, so a preview link (http://<host>:<pool port>) would not be reachable through your proxy — previews are disabled.`);
  } else {
    startPreviewSweep();
    installPreviewShutdown();
    console.log(`[preview] ports ${config.preview.ports.join(", ")} — forward each one (ssh -L <port>:127.0.0.1:<port>) to reach a preview`);
  }
}

// Bind the port BEFORE anything with side effects. A second instance — or an
// overlapping `systemctl restart` — would otherwise run the A2 resume loop first,
// spawning `claude --resume` on sessions and worktrees the LIVE daemon owns, and
// only then hit EADDRINUSE and exit. process.exit() does not reap spawned
// children, so those duplicates would be orphaned: still running with permissions
// skipped, writing into the first daemon's worktrees, invisible to both.
startServer();

// Reaping is a side effect on OTHER processes, so it waits for the port bind for
// exactly the reason above: a second instance must die on EADDRINUSE before it can
// SIGTERM the LIVE daemon's dev servers. Runs before any port is allocated, so the
// pool never comes up smaller than it looks with nothing to explain why.
if (config.preview.enabled) await reapOrphans();



// A2 durability: on (re)start, resume any task that was mid-run. Injection and
// resume are the same operation, proven by the spike.
//
// SKIPPED when we already know a spawn cannot succeed. Resuming into a guaranteed
// failure is worse than not resuming: the exit handler marks each task `error`,
// and an errored task is terminal — the loop below only picks up running/resuming,
// and the dashboard offers it no Reply and no Resume. So one restart with an unset
// systemd `User=` or a wrong PATH would permanently strand every in-flight agent.
// Left as-is, they are recovered by the next restart that can actually run them.
const canSpawn = !rootWillBlockAgents() && !!Bun.which(config.claudeBin);
if (!canSpawn) {
  console.warn("[A2] not resuming in-flight tasks — agents cannot start on this daemon (see the notices above). They stay recoverable; fix the cause and restart.");
} else {
  for (const t of store.listTasks()) {
    if (t.status === "running" || t.status === "resuming") {
      console.log(`[A2] resuming ${t.id} (${t.title}) from session ${t.sessionId ?? "—"}`);
      resumeTask(t.id);
    }
  }
}

// Opt-in: periodically drop merged done tasks (worktree + branch + row). No-op
// unless AGENTDECK_AUTO_CLEAN_MERGED=true. Started after the server so a slow
// first sweep never delays the daemon coming up.
startAutoCleanSweep();
