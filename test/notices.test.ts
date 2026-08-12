import { afterEach, beforeEach, expect, test } from "bun:test";
import { notice, notices, noticesTruncated, resetNotices, setNoticeListener } from "../src/notices.ts";

// This module is a process-wide singleton and `bun test` shares one module
// registry across files — config.test.ts feeds loadProjects malformed input,
// which lands here. Reset around every test so neither file depends on the
// other's discipline.
beforeEach(resetNotices);
afterEach(resetNotices);

test("records level, code and message, in order", () => {
  notice("warn", "host-gate", "bound off-loopback");
  notice("error", "root", "cannot start agents");
  expect(notices()).toEqual([
    { level: "warn", code: "host-gate", message: "bound off-loopback" },
    { level: "error", code: "root", message: "cannot start agents" },
  ]);
});

test("deduped by CODE, not by message", () => {
  // loadProjects warns once per malformed entry, and agent.ts raises the
  // root-bypass notice once per failing task. Neither may become N banner rows.
  notice("warn", "projects", "skipping entry 1");
  notice("warn", "projects", "skipping entry 2");
  notice("warn", "projects", "skipping entry 3");
  expect(notices()).toHaveLength(1);
  expect(notices()[0].message).toBe("skipping entry 1"); // first wins
});

test("caps the list and flags truncation", () => {
  for (let i = 0; i < 80; i++) notice("warn", `code-${i}`, `m${i}`);
  expect(notices().length).toBeLessThanOrEqual(50);
  expect(noticesTruncated()).toBe(true);
});

test("truncation stays false under the cap", () => {
  notice("warn", "a", "one");
  expect(noticesTruncated()).toBe(false);
});

test("notices() returns a copy — a caller can't mutate the record", () => {
  notice("warn", "a", "one");
  const first = notices();
  first.push({ level: "error", code: "injected", message: "nope" });
  first[0].message = "tampered";
  expect(notices()).toHaveLength(1);
  expect(notices()[0].message).toBe("one");
});

test("never throws, whatever it's handed", () => {
  // A notice is never worth crashing the daemon over. config.ts calls this during
  // module init, so a throw here would be a systemd crash-loop.
  expect(() => notice("warn", "", "")).not.toThrow();
  expect(() => notice("error", "x", undefined as any)).not.toThrow();
  expect(() => notice(undefined as any, "y", "z")).not.toThrow();
});

test("the listener sees each new notice and can read it back", () => {
  // server.ts uses this to push a RUNTIME notice (agent.ts retracting the
  // root-bypass claim) to open dashboards. It must fire after the push, or a
  // listener that serialises notices() would miss the one it was told about.
  const seen: string[] = [];
  setNoticeListener((n) => { seen.push(n.code); expect(notices().some((x) => x.code === n.code)).toBe(true); });
  notice("error", "root-bypass-failed", "the guard is back");
  expect(seen).toEqual(["root-bypass-failed"]);
});

test("a deduped notice does not re-fire the listener", () => {
  let calls = 0;
  setNoticeListener(() => { calls++; });
  notice("warn", "same", "first");
  notice("warn", "same", "second");
  expect(calls).toBe(1);
});

test("a throwing listener cannot take the daemon down", () => {
  setNoticeListener(() => { throw new Error("broken consumer"); });
  expect(() => notice("warn", "a", "one")).not.toThrow();
  expect(notices()).toHaveLength(1); // still recorded
});
