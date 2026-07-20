import { join } from "node:path";
import { config } from "./config.ts";

// Thin, honest wrappers around git. Isolation invariant: 1 task = 1 branch =
// 1 worktree, never shared. Cleanup NEVER force-deletes (eng-review finding):
// a dirty or unmerged worktree is surfaced, not destroyed.

async function git(args: string[], cwd = config.targetRepo): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

export async function baseBranch(): Promise<string> {
  const head = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (head.ok) return head.out.replace("refs/remotes/origin/", "");
  for (const b of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", b])).ok) return b;
  }
  return "main";
}

/** Create branch + worktree for a task. Returns the worktree path. */
export async function createWorktree(taskId: string, branch: string): Promise<string> {
  const base = await baseBranch();
  const path = join(config.worktreesDir, taskId);
  const r = await git(["worktree", "add", "-b", branch, path, base]);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err || r.out}`);
  return path;
}

export interface CleanupResult { removed: boolean; reason?: string }

/** Remove worktree + branch. Refuses (does not force) if dirty or unmerged. */
export async function cleanupWorktree(worktree: string, branch: string): Promise<CleanupResult> {
  const status = await git(["status", "--porcelain"], worktree);
  if (status.ok && status.out.length > 0) {
    return { removed: false, reason: "worktree is dirty — needs review before removal" };
  }
  const rm = await git(["worktree", "remove", worktree]); // no --force
  if (!rm.ok) return { removed: false, reason: `worktree remove refused: ${rm.err}` };
  const del = await git(["branch", "-d", branch]); // -d refuses unmerged; never -D
  if (!del.ok) return { removed: true, reason: `worktree removed, but branch kept (unmerged): ${del.err}` };
  return { removed: true };
}

export async function diffStat(worktree: string): Promise<string> {
  const base = await baseBranch();
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
