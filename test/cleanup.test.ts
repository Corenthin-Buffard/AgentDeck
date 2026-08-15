import { expect, test, describe } from "bun:test";
import { sweepEligible, sweepOnce, type SweepDeps } from "../src/cleanup.ts";
import type { Task } from "../src/types.ts";

// The auto-clean sweep is the destructive path — it force-deletes worktrees +
// branches. sweepOnce takes injected deps precisely so this decision (which task
// gets removed, and which is spared) is unit-tested without touching git/gh.

function task(id: string, status: string, worktree = `/wt/${id}`): Task {
  return {
    id, project: "default", title: id, prompt: "", branch: `agentdeck/${id}`, worktree,
    tmux: null, sessionId: null, status: status as Task["status"], phase: "done",
    pendingQuestion: null, lastActivity: 0, createdAt: 0, error: null,
    planReviews: { ceo: null, design: null, eng: null },
  };
}

describe("sweepEligible", () => {
  test("only 'done' is eligible — never a paused/live/errored task", () => {
    expect(sweepEligible("done")).toBe(true);
    for (const s of ["running", "waiting", "error", "resuming", "stopped"]) {
      expect(sweepEligible(s)).toBe(false);
    }
  });
});

describe("sweepOnce (delete-decision orchestration)", () => {
  // isMerged returns the proven SHA (or null). `merged` opt: true → a fixed SHA, false → null.
  function harness(
    tasks: Task[],
    opts: { merged?: (branch: string) => boolean; running?: Set<string>; previewing?: Set<string> } = {},
  ) {
    const removed: Array<{ id: string; sha: string }> = [];
    const map = new Map(tasks.map((t) => [t.id, t]));
    const deps: SweepDeps = {
      listTasks: () => tasks,
      getTask: (id) => map.get(id) ?? null,
      isRunning: (id) => opts.running?.has(id) ?? false,
      isPreviewing: (id) => opts.previewing?.has(id) ?? false,
      resolveRepo: async () => ({ repo: "/repo/default", base: "main" }),
      isMerged: async (_r, _b, branch) => ((opts.merged ? opts.merged(branch) : true) ? "sha_" + branch : null),
      remove: async (id, sha) => { removed.push({ id, sha }); map.delete(id); return { removed: true }; },
    };
    return { deps, removed };
  }
  const ids = (removed: Array<{ id: string }>) => removed.map((r) => r.id);

  test("removes a done + merged + idle task, passing the proven SHA", async () => {
    const { deps, removed } = harness([task("t1", "done")], { merged: () => true });
    await sweepOnce(deps);
    expect(removed).toEqual([{ id: "t1", sha: "sha_agentdeck/t1" }]); // SHA threaded for the CAS delete
  });

  test("never touches a running task (even if merged)", async () => {
    const { deps, removed } = harness([task("t1", "done")], { merged: () => true, running: new Set(["t1"]) });
    await sweepOnce(deps);
    expect(ids(removed)).toEqual([]);
  });

  test("never touches a non-done task (stopped/waiting)", async () => {
    const { deps, removed } = harness([task("t1", "stopped"), task("t2", "waiting")], { merged: () => true });
    await sweepOnce(deps);
    expect(ids(removed)).toEqual([]);
  });

  test("skips a done task whose branch isn't merged (isMerged → null)", async () => {
    const { deps, removed } = harness([task("t1", "done")], { merged: () => false });
    await sweepOnce(deps);
    expect(ids(removed)).toEqual([]);
  });

  test("anti-race: skips if the task became running DURING the async merge probe", async () => {
    const running = new Set<string>();
    const { deps, removed } = harness([task("t1", "done")], {
      merged: () => { running.add("t1"); return true; }, // resumed mid-probe
      running,
    });
    await sweepOnce(deps);
    expect(ids(removed)).toEqual([]); // the post-probe re-check catches it
  });

  // A preview makes the worktree a live dev server's cwd. Removing it would kill
  // the preview mid-look AND make `git worktree remove` refuse — so a task the
  // operator is currently looking at is never swept, merged or not.
  test("never touches a task with a live preview (even if merged)", async () => {
    const { deps, removed } = harness([task("t1", "done")], { merged: () => true, previewing: new Set(["t1"]) });
    await sweepOnce(deps);
    expect(ids(removed)).toEqual([]);
  });

  // `gh` is a network call, so the window between the eligibility filter and the
  // destructive remove is wide enough to click Preview in. The post-probe re-check
  // has to cover previews for the same reason it covers resumes.
  test("anti-race: skips if a preview STARTED during the async merge probe", async () => {
    const previewing = new Set<string>();
    const { deps, removed } = harness([task("t1", "done")], {
      merged: () => { previewing.add("t1"); return true; }, // operator clicked Preview mid-probe
      previewing,
    });
    await sweepOnce(deps);
    expect(ids(removed)).toEqual([]);
  });
});
