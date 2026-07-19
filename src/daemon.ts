import { mkdirSync } from "node:fs";
import { config } from "./config.ts";
import { store } from "./db.ts";
import { resumeTask } from "./agent.ts";
import { startServer } from "./server.ts";

// gorch daemon entry. Runs as a systemd --user service on the VPS so agents
// survive SSH/browser disconnects (they live here, not on your laptop).

mkdirSync(config.worktreesDir, { recursive: true });

// A2 durability: on (re)start, resume any task that was mid-run. Injection and
// resume are the same operation, proven by the spike.
for (const t of store.listTasks()) {
  if (t.status === "running" || t.status === "resuming") {
    console.log(`[A2] resuming ${t.id} (${t.title}) from session ${t.sessionId ?? "—"}`);
    resumeTask(t.id);
  }
}

startServer();
