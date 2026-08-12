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

// ── pipeline columns ────────────────────────────────────────────────────────
// Unlike `project` and `plan_reviews`, these BACKFILL rather than coalescing at
// read time. `pipeline` records a choice made when the task was created: a task
// already in flight must not change what it is doing because the operator edited
// AGENTDECK_PIPELINE and restarted the daemon.

// The real v0.2.4.1 schema — what an upgrading user's DB actually looks like.
const SCHEMA_V0241 = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL,
    branch TEXT NOT NULL, worktree TEXT NOT NULL, tmux TEXT, session_id TEXT,
    status TEXT NOT NULL, phase TEXT NOT NULL, pending_question TEXT,
    last_activity INTEGER NOT NULL, created_at INTEGER NOT NULL, error TEXT,
    plan_reviews TEXT
  );`;

describe("pipeline column migration (REGRESSION: live v0.2.4.1 schema)", () => {
  const seed = (db: Database) =>
    db.exec(`INSERT INTO tasks (id,project,title,prompt,branch,worktree,status,phase,last_activity,created_at)
             VALUES ('t_old','web','legacy','do x','agentdeck/x','/wt','running','run',1,1)`);

  test("adds all three columns and BACKFILLS legacy rows to free-form", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_V0241);
    seed(db);
    expect(cols(db)).not.toContain("pipeline");

    migrate(db);

    expect(cols(db)).toContain("pipeline");
    expect(cols(db)).toContain("step");
    expect(cols(db)).toContain("step_skill_seen");
    // Backfilled, NOT left NULL: every pre-existing row predates the feature, so
    // it is free-form. A NULL here would later read as "whatever the config says".
    const row = db.query("SELECT pipeline, step, step_skill_seen FROM tasks WHERE id='t_old'")
      .get() as { pipeline: number; step: number; step_skill_seen: number };
    expect(row.pipeline).toBe(0);
    expect(row.step).toBe(0);
    expect(row.step_skill_seen).toBe(0);
    db.close();
  });

  test("a running pipeline task keeps its stored choice across a migration re-run", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_V0241);
    migrate(db);
    db.exec(`INSERT INTO tasks (id,project,title,prompt,branch,worktree,status,phase,last_activity,created_at,pipeline,step,step_skill_seen)
             VALUES ('t_pipe','web','p','do y','agentdeck/y','/wt2','running','review',2,2,1,3,1)`);
    migrate(db); // idempotent: must not reset an in-flight task to free-form
    const row = db.query("SELECT pipeline, step, step_skill_seen FROM tasks WHERE id='t_pipe'")
      .get() as { pipeline: number; step: number; step_skill_seen: number };
    expect(row.pipeline).toBe(1);
    expect(row.step).toBe(3);
    expect(row.step_skill_seen).toBe(1);
    db.close();
  });

  test("migrates a v0.1.x DB (no project, no plan_reviews, no pipeline) in one pass", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SCHEMA);
    migrate(db);
    for (const c of ["project", "plan_reviews", "pipeline", "step", "step_skill_seen"]) {
      expect(cols(db)).toContain(c);
    }
    db.close();
  });
});
