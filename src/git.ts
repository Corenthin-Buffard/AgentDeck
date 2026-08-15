import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, symlinkSync, lstatSync, readFileSync, appendFileSync } from "node:fs";
import { config } from "./config.ts";

// Thin, honest wrappers around git. Isolation invariant: 1 task = 1 branch =
// 1 worktree, never shared. Cleanup never force-deletes BY DEFAULT (eng-review
// finding): a dirty or unmerged worktree is surfaced, not destroyed. The caller
// can opt into "commit" (save the agent's work onto the branch, then remove) or
// "force" (discard) — both are explicit, never the default.

/** How long any single git invocation may run before it is killed.
 *
 *  CLASS FIX for "a route handler awaits unbounded work". Bun.serve closes any
 *  handler past its idleTimeout (10s by default), and three routes await git —
 *  createTask (`worktree add`), the diff endpoint, and removeTask
 *  (`worktree remove`). A git call that hangs on a lock file, a stale mount or a
 *  huge worktree therefore surfaces to the operator as "request failed" on an
 *  operation that is STILL RUNNING, and their retry races the first one. Every git
 *  call in this daemon goes through git(), so bounding it here bounds all of them.
 *
 *  Generous on purpose: a real `worktree add` on a large repo is seconds, not
 *  minutes. This is a hang breaker, not a performance budget. */
const GIT_TIMEOUT_MS = 60_000;

async function git(args: string[], cwd = config.targetRepo): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  let killed = false;
  const kill = () => { killed = true; try { p.kill("SIGKILL"); } catch { /* already gone */ } };
  const timer = setTimeout(kill, GIT_TIMEOUT_MS);
  timer.unref?.();
  try {
    // Race the READS and the REAP, not just the process — same shape as bounded()
    // below, for the reason its comment gives. Killing the leader is not enough: a
    // grandchild (a hook, a credential helper) inherits stdout, so
    // `new Response(p.stdout).text()` can outlive the SIGKILL indefinitely and the
    // timeout is then inert. A first version of this function did exactly that,
    // and a hung git() pins removeTask forever.
    const read = (st: ReadableStream) => Promise.race([
      new Response(st).text(),
      new Promise<string>((r) => { const t = setTimeout(() => { kill(); r(""); }, GIT_TIMEOUT_MS + 2_000); t.unref?.(); }),
    ]);
    const [out, err] = await Promise.all([read(p.stdout), read(p.stderr)]);
    const code = await Promise.race([
      p.exited,
      new Promise<number>((r) => { const t = setTimeout(() => r(-1), 1_000); t.unref?.(); }),
    ]);
    if (killed) return { ok: false, out: out.trim(), err: `git ${args[0]} did not finish within ${GIT_TIMEOUT_MS / 1000}s` };
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e: any) {
    return { ok: false, out: "", err: `git ${args[0]} failed: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
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
export async function repoRootOf(worktree: string): Promise<string> {
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

/**
 * Ignore `.gstack/` in this repo's worktrees via the repo's LOCAL `info/exclude`
 * (never the tracked `.gitignore`). The browse-states symlink below is untracked,
 * and a managed repo won't ignore `.gstack/` on its own — without this the worktree
 * goes dirty (`?? .gstack/`), which strands `safe` cleanup and makes a `commit`
 * cleanup's `git add -A` commit the symlink into the user's project branch.
 * `info/exclude` is local + uncommitted + unshared, so nothing lands in their tree.
 * Idempotent; best-effort.
 */
async function excludeGstack(worktree: string): Promise<void> {
  const r = await git(["rev-parse", "--git-path", "info/exclude"], worktree);
  if (!r.ok) return;
  const p = resolve(worktree, r.out);
  let cur = "";
  try { cur = readFileSync(p, "utf8"); } catch { /* no exclude file yet */ }
  if (/^\.gstack\/$/m.test(cur)) return; // already excluded
  appendFileSync(p, (cur && !cur.endsWith("\n") ? "\n" : "") + ".gstack/\n");
}

/**
 * Share the project's gstack browse-states (uploaded QA cookies) into a task's
 * worktree. `$B state load <name>` resolves via git-toplevel + `.gstack/browse-states/`,
 * which for a worktree is the WORKTREE root — and a fresh worktree carries no
 * `.gstack/` — so without this a cookie state uploaded to the MAIN repo is invisible
 * to the agent (QA would run logged-out). A symlink to the live shared dir fixes it
 * without committing cookies or changing the upload path. Best-effort: cookies are
 * optional, so a failure here never blocks the task.
 */
async function linkBrowseStates(worktree: string, repoPath: string): Promise<void> {
  try {
    const repo = resolve(repoPath);                       // absolute → the symlink target is absolute even if projects.json used a relative path
    const shared = join(repo, ".gstack", "browse-states");
    const link = join(worktree, ".gstack", "browse-states");
    await excludeGstack(worktree);                        // keep the untracked symlink from dirtying the managed repo
    if (lstatSync(link, { throwIfNoEntry: false })) return; // already present (tracked?) — don't clobber
    mkdirSync(shared, { recursive: true });               // so uploads + the link agree on the path
    mkdirSync(join(worktree, ".gstack"), { recursive: true });
    symlinkSync(shared, link);
  } catch (e) {
    console.warn(`[worktree] could not link browse-states into ${worktree}: ${(e as Error).message}`);
  }
}

/** Create branch + worktree for a task in `repoPath`. Returns the worktree path. */
export async function createWorktree(taskId: string, branch: string, repoPath = config.targetRepo): Promise<string> {
  const base = await baseBranch(repoPath);
  const path = join(config.worktreesDir, taskId);
  const r = await git(["worktree", "add", "-b", branch, path, base], repoPath);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err || r.out}`);
  await linkBrowseStates(path, repoPath); // so an uploaded QA cookie state reaches the agent (and doesn't dirty the repo)
  return path;
}

export interface CleanupResult { removed: boolean; reason?: string; dirty?: boolean }

// safe   — refuse a dirty worktree (default; nothing is destroyed).
// commit — stage + commit the agent's work onto the branch, then remove the
//          worktree. The branch is kept (it now holds the work).
// force  — remove the worktree and delete the branch, discarding the work.
// merged — the caller has PROVEN the branch is merged (see isBranchMerged). Remove
//          the worktree + force-delete the branch, but REFUSE a dirty worktree or an
//          unreadable status (fail-safe): auto-clean must never nuke unexpected work.
export type CleanupMode = "safe" | "commit" | "force" | "merged";

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
  expectedSha?: string, // merged mode: the exact tip that was proven merged (CAS guard)
): Promise<CleanupResult> {
  const status = await git(["status", "--porcelain"], worktree);
  const dirty = status.ok && status.out.length > 0;

  // merged: fail safe on a dirty worktree OR an unreadable status. `!status.ok`
  // (git status errored) must NOT read as clean — that's the bug the older modes
  // carry (`dirty` is false when the command fails); auto-clean refuses instead.
  if (mode === "merged" && (!status.ok || dirty)) {
    return { removed: false, dirty, reason: !status.ok ? "could not read worktree status — refusing auto-clean" : "worktree is dirty — refusing auto-clean" };
  }
  // merged CAS pre-check: the branch must still be the EXACT commit isBranchMerged
  // proved was merged. If it advanced since (a commit landed after the proof), skip
  // — force-deleting now would discard commits that were never in the merged PR.
  if (mode === "merged" && expectedSha) {
    const cur = await git(["rev-parse", branch], worktree);
    if (!cur.ok || cur.out !== expectedSha) {
      return { removed: false, reason: "branch moved since the merge proof — kept for review" };
    }
  }
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
  // merged is clean (checked above), so its worktree needs no --force. Only `force` does.
  const rm = await git(["worktree", "remove", ...(force ? ["--force"] : []), worktree], repo);
  if (!rm.ok) return { removed: false, reason: `worktree remove refused: ${rm.err}` };

  // merged with a proven SHA: delete via an ATOMIC compare-and-swap on the ref
  // (`update-ref -d <ref> <oldvalue>` only deletes if it STILL points there). If a
  // commit landed in the tiny window since the pre-check, the CAS fails and the
  // branch (with that commit) survives — committed work is never lost.
  if (mode === "merged" && expectedSha) {
    const del = await git(["update-ref", "-d", `refs/heads/${branch}`, expectedSha], repo);
    if (!del.ok) return { removed: true, reason: `worktree removed; branch kept (moved since merge proof): ${del.err}` };
    return { removed: true };
  }

  // `force` (and `merged` without a proven SHA, a path the sweep never takes) `-D`.
  const forceDelete = force || mode === "merged";
  const del = await git(["branch", forceDelete ? "-D" : "-d", branch], repo); // -d refuses unmerged
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

// ── Auto-clean: is a task's branch merged? ───────────────────────────────────
// gh / git-fetch touch the network, so bound them with a timeout+kill (same shape
// as agent.ts refreshPlanReviews) — a hung reader must never wedge the sweep.
const NET_TIMEOUT_MS = 8000;
async function bounded(cmd: string[], cwd: string, timeoutMs = NET_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  let p: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
  } catch { return { ok: false, out: "" }; } // bin missing / spawn error → "no signal"
  let killed = false;
  const kill = () => { killed = true; try { p.kill("SIGKILL"); } catch { /* already gone */ } };
  const timer = setTimeout(kill, timeoutMs);
  try {
    // Hard-bound BOTH the read and the reap. SIGKILL can't be ignored, but a
    // grandchild could still hold stdout open past the parent's death — so race
    // the read against a deadline too. bounded() ALWAYS resolves, so a hung git/gh
    // can never wedge the sweep's `sweeping` flag (which would disable auto-clean).
    const out = await Promise.race([
      new Response(p.stdout).text(),
      new Promise<string>((r) => setTimeout(() => { kill(); r(""); }, timeoutMs + 2000)),
    ]);
    const code = await Promise.race([p.exited, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]);
    return { ok: !killed && code === 0, out: out.trim() };
  } catch { return { ok: false, out: "" }; }
  finally { clearTimeout(timer); }
}

/**
 * Is `<branch>` merged into `<base>` via a GitHub PR? Returns the exact commit SHA
 * that was proven merged (so the caller can delete via a compare-and-swap), or null.
 *
 * gh-PROVEN ONLY: a MERGED PR — filtered to THIS base (`--base`) so a PR merged into
 * staging/release doesn't count — whose head commit (`headRefOid`) IS the local tip
 * (`git rev-parse <branch>`). That proves THIS exact branch shipped into THIS base.
 * We deliberately do NOT fall back to `git --is-ancestor`: it can't tell a genuinely
 * ff-merged branch from a `done` task that committed nothing (tip already in base),
 * and this triggers a destructive delete of the task's only record — so on no PR,
 * no gh, or any doubt we return null and auto-clean never fires.
 */
export async function isBranchMerged(repo: string, base: string, branch: string): Promise<string | null> {
  const local = await git(["rev-parse", branch], repo);
  if (!local.ok || !local.out) return null;
  const localSha = local.out;
  const gh = await bounded(
    ["gh", "pr", "list", "--head", branch, "--base", base, "--state", "merged", "--json", "headRefOid", "--jq", ".[].headRefOid"],
    repo,
  );
  if (gh.ok && gh.out && gh.out.split("\n").some((s) => s.trim() === localSha)) return localSha;
  return null;
}
