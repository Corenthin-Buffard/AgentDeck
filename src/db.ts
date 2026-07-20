import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import type { Task, AgentEvent, Status, Phase } from "./types.ts";

// SQLite in WAL mode (eng-review finding: N streams + UI + hook POSTs contend).
const dbPath = join(config.dataDir, "agentdeck.db");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    branch TEXT NOT NULL,
    worktree TEXT NOT NULL,
    tmux TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    pending_question TEXT,
    last_activity INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, ts);
`);

function rowToTask(r: any): Task {
  return {
    id: r.id, title: r.title, prompt: r.prompt, branch: r.branch, worktree: r.worktree,
    tmux: r.tmux, sessionId: r.session_id, status: r.status, phase: r.phase,
    pendingQuestion: r.pending_question, lastActivity: r.last_activity,
    createdAt: r.created_at, error: r.error,
  };
}

export const store = {
  insertTask(t: Task) {
    db.query(`INSERT INTO tasks
      (id,title,prompt,branch,worktree,tmux,session_id,status,phase,pending_question,last_activity,created_at,error)
      VALUES ($id,$title,$prompt,$branch,$worktree,$tmux,$sid,$status,$phase,$pq,$la,$ca,$err)`).run({
      $id: t.id, $title: t.title, $prompt: t.prompt, $branch: t.branch, $worktree: t.worktree,
      $tmux: t.tmux, $sid: t.sessionId, $status: t.status, $phase: t.phase, $pq: t.pendingQuestion,
      $la: t.lastActivity, $ca: t.createdAt, $err: t.error,
    });
  },
  patchTask(id: string, patch: Partial<Task>) {
    const map: Record<string, string> = {
      sessionId: "session_id", pendingQuestion: "pending_question",
      lastActivity: "last_activity", createdAt: "created_at",
    };
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const set = cols.map((c) => `${map[c] ?? c} = $${c}`).join(", ");
    const params: Record<string, unknown> = { $id: id };
    for (const c of cols) params[`$${c}`] = (patch as any)[c];
    db.query(`UPDATE tasks SET ${set} WHERE id = $id`).run(params as any);
  },
  getTask(id: string): Task | null {
    const r = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
    return r ? rowToTask(r) : null;
  },
  listTasks(): Task[] {
    return db.query("SELECT * FROM tasks ORDER BY created_at DESC").all().map(rowToTask);
  },
  deleteTask(id: string) {
    db.query("DELETE FROM tasks WHERE id = ?").run(id);
    db.query("DELETE FROM events WHERE task_id = ?").run(id);
  },
  addEvent(e: AgentEvent) {
    db.query("INSERT INTO events (task_id,ts,kind,data) VALUES (?,?,?,?)")
      .run(e.taskId, e.ts, e.kind, e.data);
  },
  recentEvents(taskId: string, limit = 200): AgentEvent[] {
    return db.query("SELECT * FROM events WHERE task_id = ? ORDER BY ts DESC LIMIT ?")
      .all(taskId, limit)
      .map((r: any) => ({ taskId: r.task_id, ts: r.ts, kind: r.kind, data: r.data }))
      .reverse();
  },
};
