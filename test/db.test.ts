import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateTasks as migrate, parsePlanReviewsCol } from "../src/db.ts";
import type { PlanReviews } from "../src/types.ts";

// The `project` column migration: `CREATE TABLE IF NOT EXISTS` won't add a column
// to a pre-existing tasks table, so an older DB needs an explicit ALTER + backfill.
// This exercises the REAL exported migrateTasks against a DB seeded with the OLD
// schema, the way a user upgrading from v0.1.3.x hits it.

// The pre-multi-project schema (no `project` column).
const OLD_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
    branch TEXT NOT NULL, worktree TEXT NOT NULL, tmux TEXT, session_id TEXT,
    status TEXT NOT NULL, phase TEXT NOT NULL, pending_question TEXT,
    last_activity INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT
  );`;

describe("project column migration", () => {
  test("adds the column to an old table, leaving legacy rows NULL (coalesced at read)", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SCHEMA);
    db.exec(`INSERT INTO tasks (id,title,prompt,branch,worktree,status,phase,last_activity,created_at)
             VALUES ('t_old','legacy','do x','agentdeck/x','/wt','done','done',1,1)`);
    // column absent before migration
    let cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("project");

    migrate(db);

    cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("project");
    // No stored backfill: the legacy row stays NULL; rowToTask (db.ts) coalesces it
    // to the live first project at read time, so it always follows the current registry.
    const row = db.query("SELECT project FROM tasks WHERE id = 't_old'").get() as { project: string | null };
    expect(row.project).toBeNull();
    db.close();
  });

  test("is idempotent — a second run is a no-op and never touches stored values", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SCHEMA);
    migrate(db);
    db.exec(`INSERT INTO tasks (id,project,title,prompt,branch,worktree,status,phase,last_activity,created_at)
             VALUES ('t_new','web','fresh','do y','agentdeck/y','/wt2','running','run',2,2)`);
    migrate(db); // second run: must not error or clobber t_new's explicit 'web'
    const row = db.query("SELECT project FROM tasks WHERE id = 't_new'").get() as { project: string };
    expect(row.project).toBe("web");
    db.close();
  });
});

// The two migrations (`project`, `plan_reviews`) are independent, so a DB can sit
// at ANY prior schema. migrateTasks must add exactly the missing column(s) in each
// case — an upgrade from v0.1.x (neither), from v0.2.0.x (project only), or a
// hypothetical DB that somehow has plan_reviews but not project.
const cols = (db: Database) =>
  (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);

// pre-`project` (v0.1.x): neither column.
const SCHEMA_NEITHER = OLD_SCHEMA;
// v0.2.0.x: has `project`, no `plan_reviews`.
const SCHEMA_PROJECT_ONLY = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL,
    branch TEXT NOT NULL, worktree TEXT NOT NULL, tmux TEXT, session_id TEXT,
    status TEXT NOT NULL, phase TEXT NOT NULL, pending_question TEXT,
    last_activity INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT
  );`;
// contrived: has `plan_reviews`, no `project` — proves the two checks are independent.
const SCHEMA_REVIEWS_ONLY = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
    branch TEXT NOT NULL, worktree TEXT NOT NULL, tmux TEXT, session_id TEXT,
    status TEXT NOT NULL, phase TEXT NOT NULL, pending_question TEXT,
    last_activity INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT,
    plan_reviews TEXT
  );`;

describe("plan_reviews column migration (old-schema combinations)", () => {
  test("neither column present → adds both", () => {
    const db = new Database(":memory:"); db.exec(SCHEMA_NEITHER);
    expect(cols(db)).not.toContain("plan_reviews");
    migrate(db);
    expect(cols(db)).toContain("project");
    expect(cols(db)).toContain("plan_reviews");
    db.close();
  });
  test("project present, plan_reviews missing → adds only plan_reviews", () => {
    const db = new Database(":memory:"); db.exec(SCHEMA_PROJECT_ONLY);
    expect(cols(db)).toContain("project");
    expect(cols(db)).not.toContain("plan_reviews");
    migrate(db);
    expect(cols(db)).toContain("plan_reviews");
    db.close();
  });
  test("plan_reviews present, project missing → adds only project (checks are independent)", () => {
    const db = new Database(":memory:"); db.exec(SCHEMA_REVIEWS_ONLY);
    expect(cols(db)).toContain("plan_reviews");
    expect(cols(db)).not.toContain("project");
    migrate(db);
    expect(cols(db)).toContain("project");
    db.close();
  });
  test("both present → a full no-op", () => {
    const db = new Database(":memory:"); db.exec(SCHEMA_REVIEWS_ONLY); migrate(db); // now has both
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});

describe("plan_reviews serialize ↔ parse round-trip", () => {
  const reviews: PlanReviews = {
    ceo: { status: "clean", stale: false, detail: "scope 7/10" },
    design: { status: "clean", stale: true, detail: "score 8/10, 0 unresolved" },
    eng: { status: "not-clean", stale: false, detail: "13 issues, 2 unresolved" },
  };

  test("a full PlanReviews survives the DB column (insert JSON → read via parsePlanReviewsCol)", () => {
    const db = new Database(":memory:"); db.exec(SCHEMA_REVIEWS_ONLY);
    // Mirror insertTask/setPlanReviews: the value is stored as JSON in a TEXT column.
    db.query(`INSERT INTO tasks (id,title,prompt,branch,worktree,status,phase,last_activity,created_at,plan_reviews)
              VALUES ('t1','x','p','b','/wt','running','plan',1,1,?)`).run(JSON.stringify(reviews));
    const row = db.query("SELECT plan_reviews FROM tasks WHERE id='t1'").get() as { plan_reviews: string };
    expect(parsePlanReviewsCol(row.plan_reviews)).toEqual(reviews);
    db.close();
  });

  test("NULL / empty / garbage / partial all coalesce to the all-null default", () => {
    const NONE = { ceo: null, design: null, eng: null };
    expect(parsePlanReviewsCol(null)).toEqual(NONE);
    expect(parsePlanReviewsCol("")).toEqual(NONE);
    expect(parsePlanReviewsCol("{not json")).toEqual(NONE);
    expect(parsePlanReviewsCol("[1,2,3]")).toEqual(NONE); // valid JSON, wrong shape → coalesced keys
    // A partial object (only eng stored) fills the missing keys with null.
    expect(parsePlanReviewsCol(JSON.stringify({ eng: { status: "clean", stale: false } })))
      .toEqual({ ceo: null, design: null, eng: { status: "clean", stale: false } });
  });
});
