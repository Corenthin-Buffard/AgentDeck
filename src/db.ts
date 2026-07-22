import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import type { Task, AgentEvent, Status, Phase, PlanReviews } from "./types.ts";

const NO_REVIEWS: PlanReviews = { ceo: null, design: null, eng: null };
/** Parse the stored `plan_reviews` JSON column; any problem → the all-null default.
 *  Exported so the round-trip test exercises the REAL read path, not a clone. */
export function parsePlanReviewsCol(raw: unknown): PlanReviews {
  if (typeof raw !== "string" || !raw) return { ...NO_REVIEWS };
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return { ...NO_REVIEWS };
    return { ceo: o.ceo ?? null, design: o.design ?? null, eng: o.eng ?? null };
  } catch { return { ...NO_REVIEWS }; }
}

// SQLite in WAL mode (eng-review finding: N streams + UI + hook POSTs contend).
const dbPath = join(config.dataDir, "agentdeck.db");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project TEXT,
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
    error TEXT,
    plan_reviews TEXT
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

// The project a NULL row routes to — a pre-multi-project row, or the column the
// migration just added. Resolved at READ time (rowToTask) against the LIVE,
// boot-validated registry, so legacy rows follow the current first project
// instead of being frozen to whatever loaded first (which boot-validation might
// later drop). Never the literal 'default', which a hand-written registry need
// not contain.
const fallbackProject = () => config.projects[0]?.id ?? "default";

// Migration: `CREATE TABLE IF NOT EXISTS` won't add a column to a pre-existing
// tasks table (older builds had fewer columns). Add each missing one — that's all.
// We do NOT backfill stored values: rowToTask coalesces NULL (→ the live first
// project / the all-null reviews default), so there's no load-order coupling and
// no permanently-stale value. Each column is checked independently, so a DB at any
// prior schema (no `project`, no `plan_reviews`, or one but not the other) migrates
// correctly. Exported so the test exercises THIS code, not a hand-copied clone.
export function migrateTasks(database: Database) {
  const cols = database.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("project")) database.exec("ALTER TABLE tasks ADD COLUMN project TEXT");
  if (!has("plan_reviews")) database.exec("ALTER TABLE tasks ADD COLUMN plan_reviews TEXT");
}
migrateTasks(db);

function rowToTask(r: any): Task {
  return {
    id: r.id, project: r.project ?? fallbackProject(), title: r.title, prompt: r.prompt,
    branch: r.branch, worktree: r.worktree,
    tmux: r.tmux, sessionId: r.session_id, status: r.status, phase: r.phase,
    pendingQuestion: r.pending_question, lastActivity: r.last_activity,
    createdAt: r.created_at, error: r.error,
    planReviews: parsePlanReviewsCol(r.plan_reviews),
  };
}

export const store = {
  insertTask(t: Task) {
    db.query(`INSERT INTO tasks
      (id,project,title,prompt,branch,worktree,tmux,session_id,status,phase,pending_question,last_activity,created_at,error,plan_reviews)
      VALUES ($id,$project,$title,$prompt,$branch,$worktree,$tmux,$sid,$status,$phase,$pq,$la,$ca,$err,$pr)`).run({
      $id: t.id, $project: t.project, $title: t.title, $prompt: t.prompt, $branch: t.branch, $worktree: t.worktree,
      $tmux: t.tmux, $sid: t.sessionId, $status: t.status, $phase: t.phase, $pq: t.pendingQuestion,
      $la: t.lastActivity, $ca: t.createdAt, $err: t.error, $pr: JSON.stringify(t.planReviews),
    });
  },
  // Dedicated setter: patchTask binds each value raw, and SQLite can't bind a plain
  // object — this serializes it. Kept separate so callers can't accidentally pass a
  // live PlanReviews object through the generic patch path.
  setPlanReviews(id: string, reviews: PlanReviews) {
    db.query("UPDATE tasks SET plan_reviews = ? WHERE id = ?").run(JSON.stringify(reviews), id);
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
