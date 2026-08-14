import { randomUUID } from "node:crypto";
import { store } from "./db.ts";
import { config, projectById } from "./config.ts";
import { createWorktree, cleanupWorktree, type CleanupResult, type CleanupMode } from "./git.ts";
import { launchTask, killExisting, forgetTask } from "./agent.ts";
import { stopPreview } from "./preview.ts";
import { emitUpdate } from "./bus.ts";
import type { Task } from "./types.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/** 1 task = 1 branch = 1 worktree = 1 agent. taskId is the correlation key.
 *  `projectId` picks the repo; omitted/unknown falls back to the first project.
 *  `pipeline` decides whether the daemon drives this task through the gstack step
 *  table or leaves it free-form; it is STORED on the task, so a later change to
 *  AGENTDECK_PIPELINE never alters a task already running. */
export async function createTask(
  title: string,
  prompt: string,
  projectId?: string,
  pipeline: boolean = config.pipelineDefault,
): Promise<Task> {
  const project = projectById(projectId) ?? config.projects[0];
  if (!project) throw new Error("no project configured — add one to projects.json");
  const id = "t_" + randomUUID().slice(0, 8);
  const branch = `agentdeck/${slugify(title)}-${id.slice(2)}`;
  const worktree = await createWorktree(id, branch, project.path);
  const now = Date.now();
  const task: Task = {
    id, project: project.id, title, prompt, branch, worktree, tmux: null, sessionId: null,
    status: "running", phase: "unknown", pendingQuestion: null,
    lastActivity: now, createdAt: now, error: null,
    planReviews: { ceo: null, design: null, eng: null },
    pipeline, step: 0, stepSkillSeen: false, pipelineMissed: 0,
  };
  store.insertTask(task);
  emitUpdate(id);
  launchTask(task);
  return task;
}

/**
 * Tasks with a removal in flight.
 *
 * `removeTask` cannot delete the row up front — safe mode refuses a dirty worktree,
 * and a deleted row with a surviving worktree is worse than the race. So the row
 * stays readable for the whole of the (slow, git-bound) cleanup, and during that
 * window `store.getTask(id)` still answers, which is all the preview route checks.
 * A POST landing there used to create an entry whose task then vanished: invisible
 * to withPreviews, unreachable by DELETE (404), and holding a pool port until the
 * TTL — or forever with AGENTDECK_PREVIEW_TTL_MS=0.
 */
const removing = new Set<string>();

/** Is this task being torn down right now? beginPreview refuses these. */
export function isRemoving(id: string): boolean { return removing.has(id); }

export async function removeTask(id: string, mode: CleanupMode = "safe", expectedSha?: string): Promise<CleanupResult> {
  const t = store.getTask(id);
  if (!t) return { removed: false, reason: "not found" };
  // commit/force/merged will destroy the worktree — stop any live agent first so we
  // don't orphan the child in the running map (leaking a concurrency slot) or race
  // its writes. safe mode refuses a dirty worktree, so it never reaches removal.
  // Unconditional: safe mode is precisely the mode that SUCCEEDS for a task still
  // queued (nothing ran, so the worktree is clean). Skipping the cancel there left
  // a stale closure that later spawned `claude` into a deleted worktree, took a
  // concurrency slot for a row that no longer exists, and wrote event rows keyed to
  // a purged task_id that nothing would ever collect.
  removing.add(id);
  try {
    killExisting(id);
    // Same reasoning, one layer out: a dev server holding this worktree open is both
    // a leak (it survives the row, still bound to a pool port) and a failure — a
    // running process with the worktree as its cwd makes `git worktree remove` refuse.
    // Awaited, so the process is GONE before cleanupWorktree touches the directory.
    await stopPreview(id, "task removed");
    // expectedSha is the merged-mode CAS guard (only delete the branch if it still
    // points where isBranchMerged proved it was merged).
    const res = await cleanupWorktree(t.worktree, t.branch, mode, expectedSha);
    // Drop the in-memory retry budget with the row. taskIds are never reused, so a
    // surviving entry would leak for the daemon's lifetime.
    if (res.removed) { store.deleteTask(id); forgetTask(id); }
    // Belt and braces: the `removing` guard closes the window, this catches anything
    // already in flight when the removal started. Cheap, and the alternative is an
    // untracked dev server holding a pool port with no UI path to it.
    await stopPreview(id, "task removed");
    emitUpdate(id);
    return res;
  } finally {
    removing.delete(id);
  }
}

export function findBySession(sessionId: string): Task | undefined {
  return store.listTasks().find((t) => t.sessionId === sessionId);
}
