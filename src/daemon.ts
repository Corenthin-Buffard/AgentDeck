import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { store } from "./db.ts";
import { resumeTask } from "./agent.ts";
import { startServer } from "./server.ts";
import { hookSettings } from "./hooks-config.ts";

// AgentDeck daemon entry. Runs as a systemd --user service on the VPS so agents
// survive SSH/browser disconnects (they live here, not on your laptop).

mkdirSync(config.worktreesDir, { recursive: true });

// Write the settings file that agents load via `claude --settings` so Claude
// Code POSTs Notification/PreToolUse hook events back to us. Written before we
// resume any in-flight agent below.
if (config.notificationHooks) {
  try {
    writeFileSync(config.agentSettingsPath, JSON.stringify(hookSettings(config.hookBaseUrl), null, 2));
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
