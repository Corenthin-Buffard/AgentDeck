import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { store } from "../src/db.ts";
import { isRunning, launchTask, stopTask } from "../src/agent.ts";
import { notices, resetNotices } from "../src/notices.ts";
import type { Task } from "../src/types.ts";

// The supervisor's process handling had ZERO coverage across the whole suite —
// which is exactly why a missing `claude` binary took the entire daemon down in
// production. These use REAL subprocesses: `config.claudeBin` is pointed at a
// throwaway shell script, so the file descriptors, exit codes and signals are the
// genuine article. A mocked EventEmitter cannot fill a 64KiB pipe or produce an
// ENOENT, and those are the two failure modes that matter here.

const dir = mkdtempSync(join(tmpdir(), "agentdeck-spawn-"));
const originalBin = config.claudeBin;
const originalMax = config.maxConcurrentAgents;
const made: string[] = [];

/** Write an executable stand-in for `claude` and return its path. */
function fakeBin(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function makeTask(id: string): Task {
  const t: Task = {
    id, project: "default", title: `spawn test ${id}`, prompt: "noop",
    branch: `test/${id}`, worktree: dir, tmux: null, sessionId: null,
    status: "running", phase: "unknown", pendingQuestion: null,
    lastActivity: Date.now(), createdAt: Date.now(), error: null,
    planReviews: { ceo: null, design: null, eng: null },
  };
  store.insertTask(t);
  made.push(id);
  return t;
}

/** Poll until `check` passes or we give up — the child is a real process. */
async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

afterEach(() => {
  config.claudeBin = originalBin;
  config.maxConcurrentAgents = originalMax;
  for (const id of made.splice(0)) { try { store.deleteTask(id); } catch { /* already gone */ } }
  resetNotices();
});

test("a missing claudeBin marks the task error and LEAVES THE DAEMON ALIVE", async () => {
  // The regression. On ENOENT, Bun fires 'error' and never fires 'exit', so
  // without a handler the unhandled EventEmitter error kills the process — and
  // under systemd's Restart=on-failure plus the A2 resume loop, that is a crash
  // loop, not one dead daemon. This test file completing at all IS the assertion.
  config.claudeBin = join(dir, "definitely-not-here");
  const t = makeTask("t_enoent");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
  const err = store.getTask(t.id)!.error ?? "";
  expect(err).toContain("could not start");
  // Must name the knob that fixes it, not just say "ENOENT".
  expect(err).toContain("AGENTDECK_CLAUDE_BIN");
  // The concurrency slot was taken by attach() before the spawn failed. Without
  // pump() on the error path it is never given back, and the queue deadlocks
  // after maxConcurrentAgents failures — silently.
  expect(isRunning(t.id)).toBe(false);
});

test("stderr from a failed launch reaches task.error and the events log", async () => {
  const refusal = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";
  config.claudeBin = fakeBin("refuse", `echo "${refusal}" >&2\nexit 1`);
  const t = makeTask("t_stderr");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
  const err = store.getTask(t.id)!.error ?? "";
  expect(err).toContain("code 1");
  // The whole point: the operator reads the cause, not just an exit code.
  expect(err).toContain("root/sudo privileges");
  // And the full tail is in the drawer's events view.
  const ev = store.recentEvents(t.id, 50);
  expect(ev.some((e) => e.kind === "stderr" && e.data.includes("root/sudo"))).toBe(true);
});

test("a signalled agent reads as its signal, never 'code null'", async () => {
  config.claudeBin = fakeBin("suicide", `kill -9 $$`);
  const t = makeTask("t_signal");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
  const err = store.getTask(t.id)!.error ?? "";
  expect(err).toContain("SIGKILL");
  expect(err).not.toContain("null");
});

test("a chatty agent that overflows the pipe still exits (stderr is drained)", async () => {
  // Piping fd 2 means someone must read it: an undrained 64KiB pipe blocks the
  // child forever and the task hangs rather than fails. ~256KiB is four buffers.
  config.claudeBin = fakeBin("chatty", `i=0\nwhile [ $i -lt 4000 ]; do echo "noise line $i padded out to make it wider" >&2; i=$((i+1)); done\nexit 3`);
  const t = makeTask("t_chatty");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error", 20000)).toBe(true);
  expect(store.getTask(t.id)!.error).toContain("code 3");
  expect(isRunning(t.id)).toBe(false);
});

test("exit 0 mid-run is still an error, but carries no stderr excerpt", async () => {
  // Exiting 0 without ever emitting a `result` event means the agent died
  // without finishing its turn, so "error" is right and is the long-standing
  // behaviour. What's new is the stderr rule: we only attach the child's output
  // when the exit was ABNORMAL. A zero exit's warnings are journald's business,
  // and pasting them into task.error would dress a warning up as a cause.
  config.claudeBin = fakeBin("ok", `echo "a harmless warning" >&2\nexit 0`);
  const t = makeTask("t_clean");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
  const err = store.getTask(t.id)!.error ?? "";
  expect(err).toBe("agent exited (code 0) mid-run");
  expect(err).not.toContain("harmless warning");
  expect(store.recentEvents(t.id, 50).some((e) => e.kind === "stderr")).toBe(false);
  expect(isRunning(t.id)).toBe(false);
});

test("stopping a QUEUED task cancels it — it must not spawn later", async () => {
  // killExisting only ever inspected the `running` map, so a task still waiting
  // for a slot was invisible to it: it was marked "stopped" and then started
  // anyway when a slot freed. The marker file proves the script never ran.
  const marker = join(dir, "queued-ran.txt");
  config.maxConcurrentAgents = 1;
  config.claudeBin = fakeBin("slow", `echo started >> "${marker}"\nsleep 2\nexit 0`);

  const blocker = makeTask("t_blocker");
  const queued = makeTask("t_queued");
  launchTask(blocker);        // takes the only slot
  launchTask(queued);         // waits behind it
  expect(isRunning(queued.id)).toBe(false);

  stopTask(queued.id);
  expect(store.getTask(queued.id)!.status).toBe("stopped");

  // Let the blocker finish and free the slot — the cancelled task must not run.
  expect(await until(() => !isRunning(blocker.id), 15000)).toBe(true);
  await new Promise((r) => setTimeout(r, 400));
  expect(isRunning(queued.id)).toBe(false);
  const runs = (await Bun.file(marker).text().catch(() => "")).trim().split("\n").filter(Boolean);
  expect(runs.length).toBe(1); // only the blocker
});

test("the root bypass retracts its own claim when the guard is still refusing", async () => {
  // IS_SANDBOX is an undocumented Claude Code internal. If an upstream release
  // removes it, the amber "agents are spawned with IS_SANDBOX=1" banner would
  // keep asserting a capability that no longer exists. A failing task must
  // replace it with the truth.
  const wasAllowRoot = config.allowRoot;
  config.allowRoot = true;
  try {
    config.claudeBin = fakeBin("still-refusing", `echo "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons" >&2\nexit 1`);
    const t = makeTask("t_retract");
    launchTask(t);

    expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
    const raised = notices().find((n) => n.code === "root-bypass-failed");
    expect(raised).toBeDefined();
    expect(raised!.level).toBe("error");
  } finally {
    config.allowRoot = wasAllowRoot;
  }
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
  expect(true).toBe(true);
});
