import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearNotice, notice, notices, noticesTruncated, resetNotices, setNoticeListener } from "../src/notices.ts";

// This module is a process-wide singleton and `bun test` shares one module
// registry across files — config.test.ts feeds loadProjects malformed input,
// which lands here. Reset around every test so neither file depends on the
// other's discipline.
beforeEach(() => { resetNotices(); setNoticeListener(null); });
afterEach(() => { resetNotices(); setNoticeListener(null); });

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

test("caps the list exactly at the boundary, not one past it", () => {
  // Probing only well past the cap would let an off-by-one (`>` for `>=`, keeping
  // 51) pass both this and the under-cap test below.
  for (let i = 0; i < 50; i++) notice("warn", `code-${i}`, `m${i}`);
  expect(notices()).toHaveLength(50);
  expect(noticesTruncated()).toBe(false);

  notice("warn", "code-50", "the 51st distinct code");
  expect(notices()).toHaveLength(50);
  expect(noticesTruncated()).toBe(true);
  expect(notices().some((n) => n.code === "code-50")).toBe(false);
});

test("a repeat of an existing code at the cap is dedupe, not truncation", () => {
  // The dedupe check returns BEFORE the cap check, so re-noticing a known code
  // must not flip the truncation flag.
  for (let i = 0; i < 50; i++) notice("warn", `code-${i}`, `m${i}`);
  expect(noticesTruncated()).toBe(false);
  notice("warn", "code-0", "same code again");
  expect(noticesTruncated()).toBe(false);
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

test("the listener fires after the push, so it can read the new notice back", () => {
  // server.ts uses this to push a RUNTIME notice (agent.ts retracting the
  // root-bypass claim) to open dashboards. It must fire AFTER the push, or a
  // listener that serialises notices() would miss the one it was told about.
  let calls = 0, sawIt = false;
  setNoticeListener(() => { calls++; sawIt = notices().some((n) => n.code === "root-bypass-failed"); });
  try {
    notice("error", "root-bypass-failed", "the guard is back");
    expect(calls).toBe(1);
    expect(sawIt).toBe(true);
  } finally { setNoticeListener(null); }
});

test("clearNotice retracts a resolved condition and announces the change", () => {
  // Append-only would mean a condition that RESOLVES keeps its red banner and
  // keeps /api/health at ok:false until the process restarts.
  notice("error", "root-bypass-failed", "the guard is back");
  let announced = 0;
  setNoticeListener(() => { announced++; });
  try {
    expect(clearNotice("root-bypass-failed")).toBe(true);
    expect(notices().some((n) => n.code === "root-bypass-failed")).toBe(false);
    expect(announced).toBe(1);
    expect(clearNotice("root-bypass-failed")).toBe(false); // idempotent
    expect(announced).toBe(1);                              // and silent
  } finally { setNoticeListener(null); }
});

test("a retracted condition can recur", () => {
  // clearNotice must drop the dedupe key too, or the same problem happening again
  // would be silently swallowed.
  notice("warn", "hooks", "first time");
  clearNotice("hooks");
  notice("warn", "hooks", "second time");
  expect(notices().filter((n) => n.code === "hooks")).toHaveLength(1);
  expect(notices().find((n) => n.code === "hooks")!.message).toBe("second time");
});

test("resetNotices does NOT disarm another file's listener", () => {
  // bun test shares one module registry: a file clearing its own notices must not
  // silently kill the notice push for a server some other file started.
  let calls = 0;
  setNoticeListener(() => { calls++; });
  try {
    resetNotices();
    notice("warn", "after-reset", "still announced");
    expect(calls).toBe(1);
  } finally { setNoticeListener(null); }
});

test("a deduped notice does not re-fire the listener", () => {
  let calls = 0;
  setNoticeListener(() => { calls++; });
  try {
    notice("warn", "same", "first");
    notice("warn", "same", "second");
    expect(calls).toBe(1);
  } finally { setNoticeListener(null); }
});

test("a throwing listener cannot take the daemon down", () => {
  setNoticeListener(() => { throw new Error("broken consumer"); });
  try {
    expect(() => notice("warn", "a", "one")).not.toThrow();
    expect(notices()).toHaveLength(1); // still recorded
  } finally { setNoticeListener(null); }
});
