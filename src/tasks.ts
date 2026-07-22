import { randomUUID } from "node:crypto";
import { store } from "./db.ts";
import { config, projectById } from "./config.ts";
import { createWorktree, cleanupWorktree, type CleanupResult, type CleanupMode } from "./git.ts";
import { launchTask, killExisting } from "./agent.ts";
import { emitUpdate } from "./bus.ts";
import type { Task } from "./types.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/** 1 task = 1 branch = 1 worktree = 1 agent. taskId is the correlation key.
 *  `projectId` picks the repo; omitted/unknown falls back to the first project. */
export async function createTask(title: string, prompt: string, projectId?: string): Promise<Task> {
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
  };
  store.insertTask(task);
  emitUpdate(id);
  launchTask(task);
  return task;
}

export async function removeTask(id: string, mode: CleanupMode = "safe", expectedSha?: string): Promise<CleanupResult> {
  const t = store.getTask(id);
  if (!t) return { removed: false, reason: "not found" };
  // commit/force/merged will destroy the worktree — stop any live agent first so we
  // don't orphan the child in the running map (leaking a concurrency slot) or race
  // its writes. safe mode refuses a dirty worktree, so it never reaches removal.
  if (mode !== "safe") killExisting(id);
  // expectedSha is the merged-mode CAS guard (only delete the branch if it still
  // points where isBranchMerged proved it was merged).
  const res = await cleanupWorktree(t.worktree, t.branch, mode, expectedSha);
  if (res.removed) { store.deleteTask(id); }
  emitUpdate(id);
  return res;
}

export function findBySession(sessionId: string): Task | undefined {
  return store.listTasks().find((t) => t.sessionId === sessionId);
}
