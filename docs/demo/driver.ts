// Demo driver: boots the REAL AgentDeck server against a throwaway DB, and
// exposes a tiny control port that mutates the store + fires bus "update" so
// the dashboard updates live over its real WebSocket. No agents are spawned —
// the "agent" is replaced by a scripted state timeline for a clean capture.
//
// Run with Bun (see package.json `gif` script). The server's text-import of
// ../../public/index.html is resolved at runtime, so this serves the CURRENT
// dashboard HTML — regenerate the GIF after any dashboard change.
import { startServer } from "../../src/server.ts";
import { store } from "../../src/db.ts";
import { bus } from "../../src/bus.ts";
import type { Task, Status, Phase } from "../../src/types.ts";

startServer(); // dashboard on AGENTDECK_PORT

const now = Date.now();
function mk(id: string, title: string, branch: string, status: Status, phase: Phase, agoSec: number, extra: Partial<Task> = {}): Task {
  return {
    id, title, prompt: "", branch,
    worktree: `/srv/worktrees/${branch.replace(/\//g, "-")}`,
    tmux: null, sessionId: `sess-${id}`, status, phase,
    pendingQuestion: null, lastActivity: now - agoSec * 1000,
    createdAt: now - (agoSec + 600) * 1000, error: null, ...extra,
  };
}

// IDs use the real product format (`t_` + 8 hex, per tasks.ts).
const OAUTH = "t_7a1f9c02";
const SEED: Task[] = [
  mk("t_c2049af7", "Billing page redesign", "feat/billing", "running", "run", 24),
  mk("t_5b6d1e83", "Postgres 16 migration", "chore/pg16", "running", "review", 51),
  mk("t_3e8b40d1", "Stripe /webhooks endpoint", "feat/stripe-webhooks", "running", "qa", 12),
  mk(OAUTH, "Google OAuth", "feat/oauth-google", "running", "run", 8),
  mk("t_90fc27ab", "Dark mode dashboard", "feat/dark-mode", "done", "done", 320),
];

const QUESTION = `Two strategies for the OAuth refresh token:

  1. Rotate on every use — safer, but a DB write per request.
  2. Long-lived token + revocation list — fewer writes.

Which one for the MVP? Reply 1 or 2 (+ a sentence if you want).`;

function bump() { bus.emit("update", "demo"); }

function seed() {
  for (const t of store.listTasks()) store.deleteTask(t.id);
  for (const t of SEED) store.insertTask(t);
  bump();
}
function waiting() {
  store.patchTask(OAUTH, { status: "waiting", pendingQuestion: QUESTION, lastActivity: Date.now() });
  bump();
}
function resume() {
  store.patchTask(OAUTH, { status: "running", phase: "review", pendingQuestion: null, lastActivity: Date.now() });
  bump();
}
function done() {
  store.patchTask(OAUTH, { status: "done", phase: "done", lastActivity: Date.now() });
  bump();
}

const routes: Record<string, () => void> = { seed, waiting, resume, done };
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.DEMO_CTRL_PORT ?? 9099),
  fetch(req) {
    const p = new URL(req.url).pathname.slice(1);
    const fn = routes[p];
    if (!fn) return new Response("no", { status: 404 });
    fn();
    return new Response("ok");
  },
});
console.log("demo driver ready");
