import { basename, dirname, join, resolve } from "node:path";
import { config } from "./config.ts";

// Thin, honest wrappers around git. Isolation invariant: 1 task = 1 branch =
// 1 worktree, never shared. Cleanup never force-deletes BY DEFAULT (eng-review
// finding): a dirty or unmerged worktree is surfaced, not destroyed. The caller
// can opt into "commit" (save the agent's work onto the branch, then remove) or
// "force" (discard) — both are explicit, never the default.

async function git(args: string[], cwd = config.targetRepo): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

export async function baseBranch(cwd = config.targetRepo): Promise<string> {
  const head = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (head.ok) return head.out.replace("refs/remotes/origin/", "");
  for (const b of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", b], cwd)).ok) return b;
  }
  return "main";
}

/**
 * Given any worktree, return its main repo root — derived from the worktree
 * itself (`--git-common-dir`), not the registry. That keeps cleanup/diff
 * self-sufficient: they work even after the project is removed from projects.json.
 */
async function repoRootOf(worktree: string): Promise<string> {
  // --path-format=absolute (git 2.31+) so the common dir isn't relative to cwd;
  // fall back to plain + resolve() for older git.
  let r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree);
  if (!r.ok) r = await git(["rev-parse", "--git-common-dir"], worktree);
  if (!r.ok) return worktree; // not a worktree we can resolve — operate in place
  const commonDir = resolve(worktree, r.out);
  // Non-bare repo: common dir is `<repo>/.git` → strip to `<repo>`. Bare repo:
  // common dir IS the repo (e.g. `/srv/x.git`) → use it as-is; blindly dirname'ing
  // would hand cleanup the parent dir and leak the worktree/branch.
  return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/** Create branch + worktree for a task in `repoPath`. Returns the worktree path. */
export async function createWorktree(taskId: string, branch: string, repoPath = config.targetRepo): Promise<string> {
  const base = await baseBranch(repoPath);
  const path = join(config.worktreesDir, taskId);
  const r = await git(["worktree", "add", "-b", branch, path, base], repoPath);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err || r.out}`);
  return path;
}

export interface CleanupResult { removed: boolean; reason?: string; dirty?: boolean }

// safe   — refuse a dirty worktree (default; nothing is destroyed).
// commit — stage + commit the agent's work onto the branch, then remove the
//          worktree. The branch is kept (it now holds the work).
// force  — remove the worktree and delete the branch, discarding the work.
export type CleanupMode = "safe" | "commit" | "force";

/**
 * Remove worktree + branch. A done task's worktree is normally dirty (the agent's
 * artifact lives there uncommitted, and nothing else holds it), so `safe` refuses
 * it. `commit` preserves that work on the branch first; `force` discards it. Both
 * non-safe modes are explicit caller opt-ins, never the default.
 */
export async function cleanupWorktree(
  worktree: string,
  branch: string,
  mode: CleanupMode = "safe",
): Promise<CleanupResult> {
  const status = await git(["status", "--porcelain"], worktree);
  const dirty = status.ok && status.out.length > 0;

  if (dirty && mode === "safe") {
    // `dirty: true` lets callers offer commit/discard without matching this string.
    return { removed: false, dirty: true, reason: "worktree is dirty — needs review before removal" };
  }
  if (dirty && mode === "commit") {
    const add = await git(["add", "-A"], worktree);
    if (!add.ok) return { removed: false, reason: `could not stage work: ${add.err || add.out}` };
    // Supply an identity so the save works even in a repo with no user.name/email
    // configured (fresh VPS, locked-down CI) and never lands a bogus user@host author.
    const ci = await git(
      ["-c", "user.name=AgentDeck", "-c", "user.email=agentdeck@localhost",
        "commit", "-m", "agentdeck: save task work before cleanup"],
      worktree,
    );
    if (!ci.ok) return { removed: false, reason: `could not commit work: ${ci.err || ci.out}` };
  }

  // `worktree remove` / `branch` must run from the main repo, not the worktree
  // being removed. Derive it from the worktree so we don't depend on the registry.
  const repo = await repoRootOf(worktree);
  const force = mode === "force";
  const rm = await git(["worktree", "remove", ...(force ? ["--force"] : []), worktree], repo);
  if (!rm.ok) return { removed: false, reason: `worktree remove refused: ${rm.err}` };

  const del = await git(["branch", force ? "-D" : "-d", branch], repo); // -d refuses unmerged
  if (!del.ok) {
    // Expected in `commit` mode: the branch now has unmerged work, so we keep it.
    const kept = mode === "commit"
      ? `worktree removed; the agent's work is saved on branch ${branch}`
      : `worktree removed, but branch kept (unmerged): ${del.err}`;
    return { removed: true, reason: kept };
  }
  return { removed: true };
}

export async function diffStat(worktree: string): Promise<string> {
  // A worktree shares the repo's refs, so base + diff resolve in the worktree cwd
  // — no need to know which registry project it belongs to.
  const base = await baseBranch(worktree);
  const tracked = await git(["diff", "--stat", base], worktree);
  // `git diff` ignores untracked files, so a brand-new file an agent just wrote
  // is invisible. Surface them from `git status`. Use -z (NUL-separated, no
  // C-quoting) so paths with spaces / accents / newlines survive intact.
  const status = await git(["status", "--porcelain", "-z"], worktree);
  const all = status.ok
    ? status.out.split("\0").filter((l) => l.startsWith("??")).map((l) => l.slice(3)).filter(Boolean)
    : [];
  const CAP = 50;
  const parts: string[] = [];
  const t = tracked.ok ? tracked.out : tracked.err;
  if (t) parts.push(t);
  if (all.length) {
    const more = all.length > CAP ? ` …and ${all.length - CAP} more` : "";
    parts.push(`untracked: ${all.slice(0, CAP).join(", ")}${more}`);
  }
  return parts.join("\n"); // "" when empty → the dashboard shows its own localized fallback
}
