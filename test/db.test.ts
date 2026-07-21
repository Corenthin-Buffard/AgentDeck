import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";

// The `project` column migration (mirrors src/db.ts): `CREATE TABLE IF NOT EXISTS`
// won't add a column to a pre-existing tasks table, so an older DB needs an
// explicit ALTER + backfill. This exercises that logic against a DB seeded with
// the OLD schema, the way a user upgrading from v0.1.3.x hits it.
function migrate(db: Database, fallback: string) {
  const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "project")) {
    db.exec("ALTER TABLE tasks ADD COLUMN project TEXT");
  }
  db.query("UPDATE tasks SET project = $p WHERE project IS NULL").run({ $p: fallback });
}

// The pre-multi-project schema (no `project` column).
const OLD_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
    branch TEXT NOT NULL, worktree TEXT NOT NULL, tmux TEXT, session_id TEXT,
    status TEXT NOT NULL, phase TEXT NOT NULL, pending_question TEXT,
    last_activity INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT
  );`;

describe("project column migration", () => {
  test("adds the column and backfills existing rows to the fallback project", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SCHEMA);
    db.exec(`INSERT INTO tasks (id,title,prompt,branch,worktree,status,phase,last_activity,created_at)
             VALUES ('t_old','legacy','do x','agentdeck/x','/wt','done','done',1,1)`);
    // column absent before migration
    let cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("project");

    migrate(db, "api"); // first registry id, not the literal 'default'

    cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("project");
    const row = db.query("SELECT project FROM tasks WHERE id = 't_old'").get() as { project: string };
    expect(row.project).toBe("api");
    db.close();
  });

  test("is idempotent — a second run is a no-op and doesn't clobber set values", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SCHEMA);
    migrate(db, "api");
    db.exec(`INSERT INTO tasks (id,project,title,prompt,branch,worktree,status,phase,last_activity,created_at)
             VALUES ('t_new','web','fresh','do y','agentdeck/y','/wt2','running','run',2,2)`);
    migrate(db, "api"); // second run: must not overwrite t_new's explicit 'web'
    const row = db.query("SELECT project FROM tasks WHERE id = 't_new'").get() as { project: string };
    expect(row.project).toBe("web");
    db.close();
  });
});
