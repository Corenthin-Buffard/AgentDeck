import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml BEFORE any test file, which is the only place this can
// work. src/config.ts reads AGENTDECK_DATA_DIR at module scope and src/db.ts opens
// the SQLite file at import — so by the time a test file's own imports run, the
// database handle is already bound. Setting it here points the whole suite at a
// throwaway directory.
//
// Without this, `bun test` runs against ~/.agentdeck/agentdeck.db: the operator's
// LIVE database. test/agent-spawn.test.ts inserts task rows, so a crashed test run
// would leave phantom tasks on the real dashboard, and running the suite while a
// daemon is up would have two processes writing one SQLite file.
const created = !process.env.AGENTDECK_DATA_DIR;
if (created) {
  process.env.AGENTDECK_DATA_DIR = mkdtempSync(join(tmpdir(), "agentdeck-test-"));
}
// Never inherit a developer's real opt-in: the root matrix is exercised explicitly
// by passing values to the pure agentEnv(), and a stray `true` in the environment
// would silently change what the spawn tests are asserting.
delete process.env.AGENTDECK_ALLOW_ROOT;
// A test must never be able to reach an external service. The suite drives the
// real supervisor, whose error path calls notify() — and notify() does a live
// fetch to Telegram/Slack whenever these are set. An operator who sources their
// EnvironmentFile (the documented way to run the daemon) and then runs `bun test`
// would otherwise send a burst of real messages about fake tasks.
delete process.env.AGENTDECK_TG_TOKEN;
delete process.env.AGENTDECK_TG_CHAT;
delete process.env.AGENTDECK_SLACK_WEBHOOK;

// Take the throwaway dir with us. Only remove what we created, so an explicitly
// supplied AGENTDECK_DATA_DIR is never touched.
if (created) {
  const dir = process.env.AGENTDECK_DATA_DIR!;
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}
