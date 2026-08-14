// Process-supervision primitives shared by every long-lived child the daemon owns.
//
// These lived in agent.ts until the preview supervisor needed them too. They are
// here rather than there so a second supervisor can spawn, capture and kill a child
// WITHOUT importing the agent module — which carries `config`, `db`, `bus`,
// `notices`, `notify`, `phase` and `detect`, plus the live `running` map and
// `waitQueue` that back the AGENTDECK_MAX_AGENTS cap.
//
// That separation is the point, not tidiness. A preview must never consume an agent
// concurrency slot, and `pump()`'s `while (running.size < max)` loop is exactly the
// kind of thing that gets reused by autocomplete. Keeping it out of scope makes the
// rule structural instead of a comment asking people to be careful.
//
// Dependency budget: `config` only (itself dependency-free by construction — see
// its header). Do not add more; the value of this module is what it does NOT pull in.

import { type SpawnOptions } from "node:child_process";
import { config } from "./config.ts";

/**
 * The environment every spawned child inherits.
 *
 * Claude Code refuses `--dangerously-skip-permissions` as uid 0 unless it is told
 * it's in a deliberate sandbox, so a root daemon fails every task at spawn.
 * IS_SANDBOX=1 is that signal. We honour the refusal by DEFAULT — an operator who
 * ran the daemon as root by accident (an unset systemd `User=`) should see agents
 * fail loudly, not silently get root agents with permissions skipped.
 * AGENTDECK_ALLOW_ROOT=true is the explicit "I meant it".
 *
 * PURE + exported so the whole matrix is testable without actually being uid 0.
 * Returns `base` unchanged (not a copy) when there's nothing to add, so the common
 * path allocates nothing.
 */
export function agentEnv(base: NodeJS.ProcessEnv, allowRoot: boolean, uid: number | undefined): NodeJS.ProcessEnv {
  if (!allowRoot || uid !== 0) return base;
  return { ...base, IS_SANDBOX: "1" };
}

/**
 * Common spawn options for every launch — one helper, because with env injection
 * added, three copies of this literal is three places to get root wrong.
 *
 * stderr is PIPED rather than inherited so a crash can carry its own explanation
 * onto the task row. The agent's attach() relays every chunk back to our own stderr,
 * so journald still sees what `inherit` gave it.
 *
 * NOTE: piping means SOMEONE MUST DRAIN IT — **both streams, not just stderr**. A
 * caller that spawns without draining blocks a chatty child on a full 64KiB pipe,
 * and the symptom is not a spawn error: the child simply stops making progress and
 * looks frozen. agent.ts drains in attach(); preview.ts drains in its own spawn
 * path. Any THIRD caller must do the same.
 *
 * Not memoized on purpose: the test suite shares one `config` singleton, and a
 * cached env would make config.allowRoot un-overridable in tests.
 */
export function spawnOpts(cwd: string, uid: number | undefined): SpawnOptions {
  return {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: agentEnv(process.env, config.allowRoot, uid),
  };
}

/**
 * Signal a whole process GROUP and report whether anything was there to signal.
 *
 * `process.kill(-pid, …)` addresses the process group whose id is `pid`. That is
 * only the child's group when the child was spawned with `detached: true`, which
 * makes the child a group leader so pid === pgid. **If a caller ever drops
 * `detached`, this function silently starts signalling the DAEMON's own group.**
 * That dependency is load-bearing and invisible at the call site, which is why it
 * is written here rather than left to be rediscovered.
 *
 * Why groups at all: `npm run dev` / `pnpm dev` is a wrapper that forks the real
 * dev server and waits. Signalling the wrapper alone leaves the grandchild alive,
 * still holding its port — verified against `sh -c "listener & wait"`, which is
 * exactly that shape.
 *
 * Returns false when the group is already gone (ESRCH), so callers can treat
 * "nothing to kill" as success rather than an error.
 */
export function killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e: any) {
    if (e?.code === "ESRCH") return false; // already reaped
    throw e;
  }
}

/** Is this pid alive? `signal 0` performs the permission and existence checks
 *  without delivering anything. EPERM means it exists but isn't ours — still
 *  alive, so the answer is true. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// How much of a dead child's stderr we keep. STDERR_ERROR_MAX is the task.error
// budget — enough for the whole of a real failure (the root refusal is 93 bytes)
// without turning a card into a wall.
// One cap for every event row we persist, so no single row is an outlier and the
// coupling is enforced rather than asserted in a comment. Used by the stderr tail
// and by agent.ts's `text` event.
export const EVENT_TEXT_MAX = 2000;
const STDERR_TAIL_MAX = EVENT_TEXT_MAX;
const STDERR_ERROR_MAX = 300;
// How much unflushed relay we tolerate on our OWN stderr before we stop mirroring
// a chatty child. Only reachable when the log sink (journald) has stalled; 1 MiB
// is generous for a transient hiccup and small enough that four agents hitting it
// at once can't matter.
const STDERR_RELAY_MAX_QUEUE = 1 << 20;

/**
 * Should we mirror this chunk to our own stderr?
 *
 * PURE + exported so the rule is testable against the SHIPPED code. The first
 * implementation keyed on `process.stderr.write()` returning false, which drops
 * nothing — `false` is an advisory "past the high-water mark" and the chunk is
 * queued either way. Only the already-queued length can bound the heap.
 */
export function shouldRelay(queuedBytes: number, max = STDERR_RELAY_MAX_QUEUE): boolean {
  return queuedBytes <= max;
}

/**
 * Bounded stderr accumulator. PURE (no I/O, no timers) + exported so eviction and
 * chunk-boundary behaviour are unit-testable without spawning.
 *
 * Deliberately NOT a line picker. An earlier design latched "the first meaningful
 * line" as the cause; measuring the real failure killed it. `claude -p` with stdin
 * ignored emits exactly one 93-byte line with no ANSI — but give it a tty stdin and
 * it PREPENDS "Warning: no stdin data received in 3s…", pushing the real cause to
 * line 2. Any first-line rule would have shown the operator the stdin warning. The
 * whole (bounded) tail has no such failure mode and is less code.
 */
export function createStderrTail(max = STDERR_TAIL_MAX) {
  let tail = "";
  return {
    push(chunk: string) {
      // Slice the chunk first when it alone overflows, so a single huge write
      // doesn't build a giant intermediate string just to throw most of it away.
      tail = chunk.length >= max ? chunk.slice(-max) : (tail + chunk).slice(-max);
    },
    tail: (): string => tail,
    /** One-line excerpt for `task.error`: newlines collapsed so it can't break a
     *  card's layout, trimmed, and capped. "" when there was nothing on stderr. */
    excerpt: (): string => {
      // trim() BEFORE collapsing: a trailing "\n" would otherwise become " · "
      // and survive as a dangling "·" once the space is trimmed.
      const flat = tail.trim().replace(/\s*[\r\n]+\s*/g, " · ");
      return flat.length > STDERR_ERROR_MAX ? flat.slice(0, STDERR_ERROR_MAX - 1) + "…" : flat;
    },
  };
}

/** Why a child stopped. `signal` was previously dropped, so an OOM-killed agent
 *  read as "code null" — the literal string that started this whole investigation. */
export function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
}

/**
 * Strip secrets out of captured output before it is persisted.
 *
 * This matters BECAUSE of the capture: stderr used to be `inherit`, so it reached
 * journald and nothing else. It now lands in `task.error` and the events table,
 * both of which are served by GET reads that carry no dashboard token (only the
 * Host gate). A child inherits the daemon's environment and can read the 0600
 * agent-settings.json, whose hook URLs embed the hook token as `?token=…` — so a
 * single failed hook POST echoing its URL would publish that token to any reader.
 *
 * PURE + exported so the redaction is testable without spawning. Secrets are
 * passed in rather than read from `config` so a test can't be fooled by ordering.
 */
export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    // Guard against short/empty values: a 1-char "secret" would redact everything.
    if (!s || s.length < 8) continue;
    out = out.split(s).join("[redacted]");
  }
  // Belt and braces for anything token-shaped we didn't know to look for.
  return out.replace(/([?&](?:token|api[-_]?key|secret)=)[^&\s"']+/gi, "$1[redacted]");
}
