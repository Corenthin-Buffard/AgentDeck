import { config } from "./config.ts";
import { store } from "./db.ts";
import { repoRootOf, baseBranch, isBranchMerged, type CleanupResult } from "./git.ts";
import { removeTask } from "./tasks.ts";
import { isRunning } from "./agent.ts";
import type { Task } from "./types.ts";

// Auto-clean: once a task's branch is proven MERGED (a merged GitHub PR whose head
// is the branch tip), drop its worktree + branch + dashboard row. Opt-in
// (AGENTDECK_AUTO_CLEAN_MERGED), off by default — a silent destructive sweep is
// surprising. `done` ONLY: a `stopped` task is a deliberate pause (and can still
// hold a queued agent spawn that would land in the removed worktree), so it's never
// auto-cleaned. Every path fails SAFE: on any doubt the task is left intact.
//
//   startAutoCleanSweep() ─ setTimeout 30s → run → setInterval 5min → run
//     run (non-overlap guarded) → sweepOnce
//       ├─ eligible = listTasks().filter(done && !isRunning)
//       └─ per task: resolve {repo,base} → isBranchMerged (gh) → re-check
//                    still done+idle → remove(id, provenSha) ("merged" mode, CAS delete)

const BOOT_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Terminal + idle enough to auto-clean. `done` only — see module header. */
export function sweepEligible(status: string): boolean {
  return status === "done";
}

/** Injected so the delete-decision orchestration is unit-testable without git/gh. */
export interface SweepDeps {
  listTasks: () => Task[];
  getTask: (id: string) => Task | null;
  isRunning: (id: string) => boolean;
  resolveRepo: (worktree: string) => Promise<{ repo: string; base: string }>;
  isMerged: (repo: string, base: string, branch: string) => Promise<string | null>; // proven SHA or null
  remove: (id: string, expectedSha: string) => Promise<CleanupResult>;
}

const realDeps: SweepDeps = {
  listTasks: () => store.listTasks(),
  getTask: (id) => store.getTask(id),
  isRunning,
  resolveRepo: async (wt) => { const repo = await repoRootOf(wt); return { repo, base: await baseBranch(repo) }; },
  isMerged: isBranchMerged,
  remove: (id, sha) => removeTask(id, "merged", sha),
};

/** One sweep pass. Best-effort per task — a repo hiccup never aborts the whole run. */
export async function sweepOnce(deps: SweepDeps = realDeps): Promise<void> {
  const eligible = deps.listTasks().filter((t) => sweepEligible(t.status) && !deps.isRunning(t.id));
  for (const t of eligible) {
    try {
      const { repo, base } = await deps.resolveRepo(t.worktree);
      const sha = await deps.isMerged(repo, base, t.branch); // proven merged tip (gh), or null
      if (!sha) continue;
      // Anti-race: the merge probe was async and slow (network). Re-confirm the task
      // is STILL terminal + idle before the destructive remove — it may have been
      // resumed or already cleaned in the meantime.
      const fresh = deps.getTask(t.id);
      if (!fresh || !sweepEligible(fresh.status) || deps.isRunning(t.id)) continue;
      // Pass the proven SHA so the branch delete is a compare-and-swap: if a commit
      // landed since the proof, the delete no-ops and the branch survives.
      const res = await deps.remove(t.id, sha);
      if (res.removed) console.log(`[auto-clean] removed merged task ${t.id} (${t.branch}) — work is in the base branch`);
    } catch { /* best-effort per task */ }
  }
}

let sweeping = false;
/** Start the periodic sweep if opted in. Non-overlap guarded so a slow sweep
 *  (many tasks / slow network) never stacks on the next interval tick. */
export function startAutoCleanSweep(): void {
  if (!config.autoCleanMerged) return;
  console.log(`[auto-clean] enabled — sweeping merged 'done' tasks every ${SWEEP_INTERVAL_MS / 60000}min`);
  const run = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await sweepOnce(); } catch { /* never throw out of the timer */ } finally { sweeping = false; }
  };
  setTimeout(run, BOOT_DELAY_MS);
  setInterval(run, SWEEP_INTERVAL_MS);
}
