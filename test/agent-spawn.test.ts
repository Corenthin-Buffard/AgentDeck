import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { store } from "../src/db.ts";
import { answer, isRunning, launchTask, stopTask } from "../src/agent.ts";
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

// Teardown belongs in a hook, not a trailing test case: a test case relies on file
// order, inflates the reported count, and is skipped entirely if an earlier test
// aborts the file.
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

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
  // ~200KB across 200 lines = several 64KiB pipe buffers, but 20x less console
  // noise than 4000 short lines (which buried real failures in the CI log).
  const wide = "x".repeat(1000);
  config.claudeBin = fakeBin("chatty", `i=0\nwhile [ $i -lt 200 ]; do echo "${wide}" >&2; i=$((i+1)); done\nexit 3`);
  const t = makeTask("t_chatty");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error", 20000)).toBe(true);
  expect(store.getTask(t.id)!.error).toContain("code 3");
  expect(isRunning(t.id)).toBe(false);
}, 30000);

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
  config.claudeBin = fakeBin("slow", `echo started >> "${marker}"\nsleep 0.5\nexit 0`);

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
}, 30000);

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

test("an agent that merely PRINTS the refusal does not raise the daemon notice", async () => {
  // The trigger is agent-controlled bytes deciding a daemon-level verdict, so it
  // has to be narrow. An agent working on this very repo would hit the phrase in
  // README.md, CHANGELOG.md and agent.ts; without the sawInit gate it could flip
  // /api/health to ok:false permanently with an undismissable error banner.
  const wasAllowRoot = config.allowRoot;
  config.allowRoot = true;
  try {
    // Emits a real init event first (so the launch demonstrably got past Claude
    // Code's startup checks), THEN prints the phrase, then fails for its own reasons.
    config.claudeBin = fakeBin("prints-phrase", [
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
      `echo "the docs mention root/sudo privileges here" >&2`,
      `exit 1`,
    ].join("\n"));
    const t = makeTask("t_phrase");
    launchTask(t);

    expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
    expect(notices().find((n) => n.code === "root-bypass-failed")).toBeUndefined();
  } finally {
    config.allowRoot = wasAllowRoot;
  }
});

test("captured stderr is scrubbed of the daemon's own tokens before it is stored", async () => {
  // task.error and the events row are both served by ungated GET reads.
  config.claudeBin = fakeBin("leaks-token",
    `echo "hook POST failed: http://127.0.0.1:8787/hooks/notification?token=${config.hookToken}" >&2\nexit 1`);
  const t = makeTask("t_leak");
  launchTask(t);

  expect(await until(() => store.getTask(t.id)?.status === "error")).toBe(true);
  expect(store.getTask(t.id)!.error ?? "").not.toContain(config.hookToken);
  for (const e of store.recentEvents(t.id, 50)) expect(e.data).not.toContain(config.hookToken);
});

test("answering a QUEUED task does not double-spawn on one session", async () => {
  // The dangerous half of the queue bug: killExisting only inspected `running`, so
  // a task still waiting for a slot was invisible to it and answer() scheduled a
  // SECOND launch beside the pending first. Both then ran `claude --resume` on one
  // session, attach() overwrote the map entry so the cap was silently breached, and
  // the orphan's terminal handler skipped pump(), leaking a slot.
  const marker = join(dir, "resume-runs.txt");
  config.maxConcurrentAgents = 1;
  config.claudeBin = fakeBin("record-resume", `echo "$@" >> "${marker}"\nsleep 0.3\nexit 0`);

  const blocker = makeTask("t_ans_blocker");
  const queued = makeTask("t_ans_queued");
  store.patchTask(queued.id, { sessionId: "sess-queued" }); // answer() needs one
  launchTask(blocker);   // takes the only slot
  launchTask(queued);    // waits behind it
  expect(isRunning(queued.id)).toBe(false);

  answer(queued.id, "first answer");
  answer(queued.id, "second answer");   // supersedes the first, must not stack

  expect(await until(() => !isRunning(blocker.id), 20000)).toBe(true);
  expect(await until(() => !isRunning(queued.id) && store.getTask(queued.id)?.status !== "running", 20000)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));

  const runs = (await Bun.file(marker).text().catch(() => "")).trim().split("\n").filter(Boolean);
  const resumes = runs.filter((l) => l.includes("sess-queued"));
  expect(resumes.length).toBe(1);       // exactly one resume reached the session
  expect(isRunning(queued.id)).toBe(false);
}, 40000);

test("a replacement waits for the outgoing agent to exit — never two on one session", async () => {
  // killExisting used to SIGTERM and return in the same tick, so the replacement
  // spawned while the old `claude` was still alive: two agents appending to one
  // session transcript and editing one worktree, silently. This fake ignores
  // SIGTERM for a moment and records overlap, so any regression shows up as a
  // concurrent-run count above 1.
  const log = join(dir, "overlap.txt");
  config.maxConcurrentAgents = 4;
  config.claudeBin = fakeBin("stubborn", [
    `trap '' TERM`,               // ignore SIGTERM, like a claude mid tool-call
    `echo "start $$" >> "${log}"`,
    `sleep 1`,
    `echo "end $$" >> "${log}"`,
    `exit 0`,
  ].join("\n"));

  const t = makeTask("t_overlap");
  store.patchTask(t.id, { sessionId: "sess-overlap" });
  launchTask(t);
  expect(await until(() => isRunning(t.id))).toBe(true);
  await new Promise((r) => setTimeout(r, 150));   // let it get going

  answer(t.id, "replace it");                      // must wait for the old one to die

  expect(await until(() => {
    const txt = require("node:fs").existsSync(log) ? require("node:fs").readFileSync(log, "utf8") : "";
    return txt.split("\n").filter((l: string) => l.startsWith("end")).length >= 2;
  }, 25000)).toBe(true);

  const lines = (await Bun.file(log).text()).trim().split("\n").filter(Boolean);
  // Walk the log: a "start" before the previous "end" means two agents overlapped.
  let live = 0, maxLive = 0;
  for (const l of lines) {
    if (l.startsWith("start")) { live++; maxLive = Math.max(maxLive, live); }
    else live--;
  }
  expect(maxLive).toBe(1);
}, 40000);
