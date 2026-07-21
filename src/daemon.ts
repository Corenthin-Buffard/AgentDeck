import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { config } from "./config.ts";
import { store } from "./db.ts";
import { resumeTask } from "./agent.ts";
import { startServer } from "./server.ts";
import { hookSettings } from "./hooks-config.ts";

// AgentDeck daemon entry. Runs as a systemd --user service on the VPS so agents
// survive SSH/browser disconnects (they live here, not on your laptop).

mkdirSync(config.worktreesDir, { recursive: true });
mkdirSync(config.uploadsDir, { recursive: true });

// Boot-validate the project registry: drop any path that isn't a git repo so a
// typo'd projects.json never silently routes a task into the wrong (or no) repo.
// Runs here (not at config import) to keep config.ts pure and off the test path.
config.projects = config.projects.filter((p) => {
  const r = Bun.spawnSync(["git", "-C", p.path, "rev-parse", "--git-dir"]);
  if (r.exitCode !== 0) { console.warn(`[projects] '${p.id}' is not a git repo, skipping: ${p.path}`); return false; }
  return true;
});
if (!config.projects.length) {
  console.error("[projects] no valid project — create-task will 400 until projects.json points at a git repo");
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
    console.warn(`[hooks] disabled: could not write ${config.agentSettingsPath}: ${(e as Error).message}`);
  }
}

// A2 durability: on (re)start, resume any task that was mid-run. Injection and
// resume are the same operation, proven by the spike.
for (const t of store.listTasks()) {
  if (t.status === "running" || t.status === "resuming") {
    console.log(`[A2] resuming ${t.id} (${t.title}) from session ${t.sessionId ?? "—"}`);
    resumeTask(t.id);
  }
}

startServer();
