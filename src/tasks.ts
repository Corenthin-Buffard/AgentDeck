import { randomUUID } from "node:crypto";
import { store } from "./db.ts";
import { createWorktree, cleanupWorktree, type CleanupResult } from "./git.ts";
import { launchTask } from "./agent.ts";
import { emitUpdate } from "./bus.ts";
import type { Task } from "./types.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/** 1 task = 1 branch = 1 worktree = 1 agent. taskId is the correlation key. */
export async function createTask(title: string, prompt: string): Promise<Task> {
  const id = "t_" + randomUUID().slice(0, 8);
  const branch = `gorch/${slugify(title)}-${id.slice(2)}`;
  const worktree = await createWorktree(id, branch);
  const now = Date.now();
  const task: Task = {
    id, title, prompt, branch, worktree, tmux: null, sessionId: null,
    status: "running", phase: "unknown", pendingQuestion: null,
    lastActivity: now, createdAt: now, error: null,
  };
  store.insertTask(task);
  emitUpdate(id);
  launchTask(task);
  return task;
}

export async function removeTask(id: string): Promise<CleanupResult> {
  const t = store.getTask(id);
  if (!t) return { removed: false, reason: "not found" };
  const res = await cleanupWorktree(t.worktree, t.branch);
  if (res.removed) { store.deleteTask(id); }
  emitUpdate(id);
  return res;
}

export function findBySession(sessionId: string): Task | undefined {
  return store.listTasks().find((t) => t.sessionId === sessionId);
}
