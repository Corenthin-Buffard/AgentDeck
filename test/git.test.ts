import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.ts";
import { cleanupWorktree, createWorktree } from "../src/git.ts";

// cleanupWorktree runs git in config.targetRepo. Point it at a throwaway repo for
// this file, then restore — `config` is a shared singleton, so leaving it changed
// would break other suites (e.g. server.test.ts) that share the process.
const REPO = mkdtempSync(join(tmpdir(), "agentdeck-git-repo-"));
const WTS = mkdtempSync(join(tmpdir(), "agentdeck-git-wts-"));
const g = (args: string[], cwd = REPO) => spawnSync("git", args, { cwd, encoding: "utf8" });
let savedTargetRepo: string;

beforeAll(() => {
  savedTargetRepo = config.targetRepo;
  config.targetRepo = REPO;
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@test.local"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(REPO, "README.md"), "# base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
});

afterAll(() => {
  config.targetRepo = savedTargetRepo;
  rmSync(REPO, { recursive: true, force: true });
  rmSync(WTS, { recursive: true, force: true });
});

// A fresh worktree on its own branch with an uncommitted artifact (the normal
// state of a done task's worktree).
function dirtyWorktree(name: string): { wt: string; branch: string } {
  const wt = join(WTS, name);
  const branch = `agentdeck/${name}`;
  g(["worktree", "add", "-b", branch, wt, "HEAD"]);
  writeFileSync(join(wt, "color.txt"), "blue\n"); // untracked → dirty
  return { wt, branch };
}
const branchExists = (b: string) => g(["rev-parse", "--verify", b]).status === 0;

describe("cleanupWorktree", () => {
  test("safe mode refuses a dirty worktree, destroying nothing", async () => {
    const { wt, branch } = dirtyWorktree("safe");
    const r = await cleanupWorktree(wt, branch, "safe");
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/dirty/);
    expect(branchExists(branch)).toBe(true); // still there
    g(["worktree", "remove", "--force", wt]);
    g(["branch", "-D", branch]);
  });

  test("commit mode preserves the work on the branch and removes the worktree", async () => {
    const { wt, branch } = dirtyWorktree("commit");
    const r = await cleanupWorktree(wt, branch, "commit");
    expect(r.removed).toBe(true);
    expect(r.reason).toMatch(new RegExp(branch));
    // the artifact is now committed on the branch (recoverable), worktree gone
    const show = g(["show", `${branch}:color.txt`]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("blue");
    expect(branchExists(branch)).toBe(true);
    // the save carries a deterministic identity, not a bogus user@host (works even
    // in a repo with no configured git identity)
    const author = g(["log", "-1", "--format=%an", branch]).stdout.trim();
    expect(author).toBe("AgentDeck");
    g(["branch", "-D", branch]);
  });

  test("force mode is a total discard — deletes the branch even with committed work", async () => {
    const { wt, branch } = dirtyWorktree("committed");
    g(["add", "-A"], wt);
    g(["commit", "-qm", "real committed work"], wt); // branch now has a real commit
    const r = await cleanupWorktree(wt, branch, "force");
    expect(r.removed).toBe(true);
    expect(branchExists(branch)).toBe(false); // -D discards the committed work too
  });

  test("force mode discards the work and removes worktree + branch", async () => {
    const { wt, branch } = dirtyWorktree("force");
    const r = await cleanupWorktree(wt, branch, "force");
    expect(r.removed).toBe(true);
    expect(branchExists(branch)).toBe(false); // gone
  });

  test("safe mode cleanly removes a worktree with no changes", async () => {
    const wt = join(WTS, "clean");
    const branch = "agentdeck/clean";
    g(["worktree", "add", "-b", branch, wt, "HEAD"]); // no dirty file
    const r = await cleanupWorktree(wt, branch, "safe");
    expect(r.removed).toBe(true);
    expect(branchExists(branch)).toBe(false); // merged (== base) → -d succeeds
  });
});

// Multi-project: createWorktree targets an arbitrary repo path, and cleanup
// derives the repo FROM the worktree (via --git-common-dir), so it works even
// when config.targetRepo points elsewhere — i.e. after the project has been
// removed from the registry.
describe("multi-project worktree routing", () => {
  const REPO2 = mkdtempSync(join(tmpdir(), "agentdeck-git-repo2-"));
  const WTS2 = mkdtempSync(join(tmpdir(), "agentdeck-git-wts2-"));
  const g2 = (args: string[], cwd = REPO2) => spawnSync("git", args, { cwd, encoding: "utf8" });
  let savedTargetRepo: string, savedWorktreesDir: string;

  beforeAll(() => {
    savedTargetRepo = config.targetRepo;
    savedWorktreesDir = config.worktreesDir;
    // Point targetRepo at REPO1 on purpose — cleanup must NOT rely on it.
    config.targetRepo = REPO;
    config.worktreesDir = WTS2;
    g2(["init", "-q", "-b", "main"]);
    g2(["config", "user.email", "t@test.local"]);
    g2(["config", "user.name", "t"]);
    writeFileSync(join(REPO2, "README.md"), "# repo2\n");
    g2(["add", "-A"]);
    g2(["commit", "-qm", "init"]);
  });

  afterAll(() => {
    config.targetRepo = savedTargetRepo;
    config.worktreesDir = savedWorktreesDir;
    rmSync(REPO2, { recursive: true, force: true });
    rmSync(WTS2, { recursive: true, force: true });
  });

  test("createWorktree lands the branch in the given repo, not targetRepo", async () => {
    const wt = await createWorktree("t_multi", "agentdeck/multi", REPO2);
    // the branch exists in REPO2…
    expect(g2(["rev-parse", "--verify", "agentdeck/multi"]).status).toBe(0);
    // …and NOT in REPO1 (config.targetRepo)
    expect(g(["rev-parse", "--verify", "agentdeck/multi"]).status).not.toBe(0);
    // cleanup with config.targetRepo still = REPO1 succeeds by deriving REPO2 from
    // the worktree — the "project removed from the registry" case.
    writeFileSync(join(wt, "artifact.txt"), "work\n"); // untracked → dirty
    const r = await cleanupWorktree(wt, "agentdeck/multi", "commit");
    expect(r.removed).toBe(true);
    // the saved work is on the branch in REPO2 (proves the derive worked)
    const show = g2(["show", "agentdeck/multi:artifact.txt"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("work");
    g2(["branch", "-D", "agentdeck/multi"]);
  });
});
