import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.ts";
import { cleanupWorktree, createWorktree, isBranchMerged } from "../src/git.ts";

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

  // "merged" is the auto-clean mode: the caller has PROVEN the branch merged, so it
  // force-deletes the branch (squash-safe) — but still refuses a dirty/unreadable
  // worktree so a surprise uncommitted artifact is never nuked.
  test("merged mode removes a clean worktree and force-deletes the branch", async () => {
    const wt = join(WTS, "merged-clean");
    const branch = "agentdeck/merged-clean";
    g(["worktree", "add", "-b", branch, wt, "HEAD"]); // clean
    const r = await cleanupWorktree(wt, branch, "merged");
    expect(r.removed).toBe(true);
    expect(branchExists(branch)).toBe(false);
  });

  test("merged mode REFUSES a dirty worktree — preserves unexpected work", async () => {
    const { wt, branch } = dirtyWorktree("merged-dirty");
    const r = await cleanupWorktree(wt, branch, "merged");
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/dirty/);
    expect(branchExists(branch)).toBe(true); // preserved
    g(["worktree", "remove", "--force", wt]);
    g(["branch", "-D", branch]);
  });

  test("merged mode REFUSES when git status can't be read (fail-safe, not 'clean')", async () => {
    // A dir that isn't a git worktree → `git status` errors. The older modes read
    // that as clean (dirty=false); merged must refuse instead.
    const bogus = join(WTS, "not-a-worktree");
    mkdirSync(bogus, { recursive: true });
    const r = await cleanupWorktree(bogus, "agentdeck/none", "merged");
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/could not read|status/i);
  });

  // The sweep passes the exact SHA isBranchMerged proved, and the branch delete is a
  // compare-and-swap: a branch that moved since the proof is never force-deleted.
  test("merged mode with a matching expectedSha removes via compare-and-swap", async () => {
    const wt = join(WTS, "merged-cas");
    const branch = "agentdeck/merged-cas";
    g(["worktree", "add", "-b", branch, wt, "HEAD"]);
    const sha = g(["rev-parse", branch]).stdout.trim();
    const r = await cleanupWorktree(wt, branch, "merged", sha);
    expect(r.removed).toBe(true);
    expect(branchExists(branch)).toBe(false);
  });

  test("merged mode REFUSES when the branch moved since the proof (stale expectedSha)", async () => {
    const wt = join(WTS, "merged-moved");
    const branch = "agentdeck/merged-moved";
    g(["worktree", "add", "-b", branch, wt, "HEAD"]);
    const stale = "0".repeat(40); // never the real tip
    const r = await cleanupWorktree(wt, branch, "merged", stale);
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/moved/);
    expect(branchExists(branch)).toBe(true); // preserved, nothing removed
    g(["worktree", "remove", "--force", wt]);
    g(["branch", "-D", branch]);
  });
});

// isBranchMerged is gh-PROVEN ONLY (a merged PR whose head == the local tip) — there
// is deliberately NO git --is-ancestor fallback (it can't tell a merged branch from a
// zero-commit one, and this triggers a destructive delete). In this suite the origin
// is a local bare repo (not GitHub), so `gh` can't resolve it → the tests assert the
// fail-safe: being an ancestor of origin/base is NOT enough; without a PR → null.
// The positive gh path (headRefOid == tip) is verified live against the real repo.
describe("isBranchMerged (gh-proven only, fail-safe)", () => {
  const ORIGIN = mkdtempSync(join(tmpdir(), "agentdeck-origin-"));
  const REPO3 = mkdtempSync(join(tmpdir(), "agentdeck-merged-repo-"));
  const g3 = (args: string[], cwd = REPO3) => spawnSync("git", args, { cwd, encoding: "utf8" });

  beforeAll(() => {
    spawnSync("git", ["init", "--bare", "-b", "main", ORIGIN], { encoding: "utf8" });
    spawnSync("git", ["clone", "-q", ORIGIN, REPO3], { encoding: "utf8" });
    g3(["config", "user.email", "t@test.local"]);
    g3(["config", "user.name", "t"]);
    writeFileSync(join(REPO3, "README.md"), "# base\n");
    g3(["add", "-A"]); g3(["commit", "-qm", "init"]);
    g3(["push", "-q", "-u", "origin", "main"]);
    // a branch that IS an ancestor of origin/main (would fool a --is-ancestor fallback)
    g3(["checkout", "-q", "-b", "agentdeck/merged"]);
    writeFileSync(join(REPO3, "m.txt"), "m\n");
    g3(["add", "-A"]); g3(["commit", "-qm", "merged work"]);
    g3(["checkout", "-q", "main"]);
    g3(["merge", "-q", "--no-ff", "-m", "merge", "agentdeck/merged"]);
    g3(["push", "-q", "origin", "main"]);
    // an OPEN (unmerged) branch
    g3(["checkout", "-q", "-b", "agentdeck/open"]);
    writeFileSync(join(REPO3, "o.txt"), "o\n");
    g3(["add", "-A"]); g3(["commit", "-qm", "open work"]);
    g3(["checkout", "-q", "main"]);
  });
  afterAll(() => {
    rmSync(ORIGIN, { recursive: true, force: true });
    rmSync(REPO3, { recursive: true, force: true });
  });

  test("an ancestor-of-base branch with NO GitHub PR → null (fallback removed, fail-safe)", async () => {
    // agentdeck/merged is an ancestor of origin/main, but there is no merged PR → null.
    expect(await isBranchMerged(REPO3, "main", "agentdeck/merged")).toBeNull();
  });
  test("an unmerged branch → null", async () => {
    expect(await isBranchMerged(REPO3, "main", "agentdeck/open")).toBeNull();
  });
  test("a nonexistent branch → null (rev-parse fails)", async () => {
    expect(await isBranchMerged(REPO3, "main", "agentdeck/ghost")).toBeNull();
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

  // QA-cookie delivery: `$B state load qa` resolves .gstack/browse-states via
  // git-toplevel (= the worktree root), so an uploaded state in the MAIN repo is
  // invisible unless the worktree links to it. createWorktree symlinks it in.
  test("createWorktree links the project's browse-states into the worktree", async () => {
    // simulate the AgentDeck upload: a cookie state in the MAIN repo
    mkdirSync(join(REPO2, ".gstack", "browse-states"), { recursive: true });
    writeFileSync(join(REPO2, ".gstack", "browse-states", "qa.json"), '{"cookies":[],"pages":[]}');
    const wt = await createWorktree("t_cookie", "agentdeck/cookie", REPO2);
    const linkPath = join(wt, ".gstack", "browse-states");
    const seen = join(linkPath, "qa.json");
    // the worktree resolves the uploaded state through the link…
    expect(existsSync(seen)).toBe(true);
    expect(readFileSync(seen, "utf8")).toContain("cookies");
    // …it's a symlink (a live view of the shared dir), not a stale copy…
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // …with an ABSOLUTE target (robust even if projects.json used a relative path)…
    expect(isAbsolute(readlinkSync(linkPath))).toBe(true);
    // …and it does NOT dirty the managed repo: info/exclude ignores .gstack/, so
    // `safe` cleanup still works and a `commit` cleanup won't commit the symlink.
    expect(g2(["status", "--porcelain"], wt).stdout.trim()).toBe("");
    g2(["worktree", "remove", "--force", wt]);
    g2(["branch", "-D", "agentdeck/cookie"]);
  });
});
