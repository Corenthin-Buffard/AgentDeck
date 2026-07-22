import { expect, test, describe } from "bun:test";
import { parsePlanReviews } from "../src/agent.ts";

// parsePlanReviews turns `gstack-review-read` output (a branch's plan-review-log
// JSONL, then ---CONFIG---, then ---HEAD--- + the current short HEAD) into the
// three CEO/Design/Eng states the dashboard renders. Pure fn, no process.

// A realistic reader dump: two eng entries (the log is append-only, so the LAST
// one must win), one design, one ceo, plus a codex entry that must be ignored.
const SAMPLE = [
  `{"skill":"plan-eng-review","timestamp":"2026-07-20T12:41:41Z","status":"clean","unresolved":2,"critical_gaps":0,"issues_found":15,"mode":"FULL_REVIEW","commit":"1dbc5fe"}`,
  `{"skill":"plan-design-review","timestamp":"2026-07-21T18:53:29Z","status":"clean","initial_score":4,"overall_score":8,"unresolved":0,"decisions_made":3,"commit":"d04fb79"}`,
  `{"skill":"plan-ceo-review","timestamp":"2026-07-21T18:00:00Z","status":"clean","unresolved":0,"scope_proposed":10,"scope_accepted":7,"commit":"d04fb79"}`,
  `{"skill":"codex-plan-review","timestamp":"2026-07-21T21:03:40Z","status":"issues_found","source":"codex","commit":"d04fb79"}`,
  `{"skill":"plan-eng-review","timestamp":"2026-07-21T21:03:40Z","status":"clean","unresolved":0,"critical_gaps":0,"issues_found":13,"mode":"FULL_REVIEW","commit":"d04fb79"}`,
  `---CONFIG---`,
  `false`,
  `---HEAD---`,
  `d04fb79`,
].join("\n");

describe("parsePlanReviews", () => {
  test("maps the three plan skills, ignores others, and keeps the LAST entry per skill", () => {
    const r = parsePlanReviews(SAMPLE);
    // Eng: the SECOND eng entry (13 issues @ d04fb79) wins over the first (15 @ 1dbc5fe).
    expect(r.eng).toEqual({ status: "clean", stale: false, detail: "13 issues, 0 unresolved" });
    expect(r.design).toEqual({ status: "clean", stale: false, detail: "score 8/10, 0 unresolved" });
    expect(r.ceo).toEqual({ status: "clean", stale: false, detail: "scope 7/10" });
    // codex-plan-review is not one of the three → no phantom key leaked in.
  });

  test("stale = the review's commit differs from the current HEAD", () => {
    const out = [
      `{"skill":"plan-eng-review","status":"clean","issues_found":11,"unresolved":0,"commit":"aaaaaaa"}`,
      `---CONFIG---`, `false`, `---HEAD---`, `bbbbbbb`,
    ].join("\n");
    expect(parsePlanReviews(out).eng).toEqual({ status: "clean", stale: true, detail: "11 issues, 0 unresolved" });
  });

  test("short-SHA length growth is NOT stale — same commit, longer HEAD (prefix match)", () => {
    // `git rev-parse --short` grows the SHA as the repo gains commits, so the log's
    // 7-char commit and an 8-char HEAD for the SAME commit must not read as stale.
    const out = [
      `{"skill":"plan-eng-review","status":"clean","issues_found":1,"unresolved":0,"commit":"d04fb79"}`,
      `---CONFIG---`, `false`, `---HEAD---`, `d04fb790`,
    ].join("\n");
    expect(parsePlanReviews(out).eng!.stale).toBe(false);
    // Genuinely different commits (no shared prefix) ARE stale.
    const diff = [
      `{"skill":"plan-eng-review","status":"clean","issues_found":1,"unresolved":0,"commit":"d04fb79"}`,
      `---CONFIG---`, `false`, `---HEAD---`, `abc1234`,
    ].join("\n");
    expect(parsePlanReviews(diff).eng!.stale).toBe(true);
  });

  test("a data line embedding the marker text mid-string doesn't hijack parsing (findLastIndex + endsWith)", () => {
    // A shared review log can carry other skills' entries; a field embedding
    // `---HEAD---` mid-string must NOT be mistaken for the trailer.
    const out = [
      `{"skill":"plan-eng-review","status":"clean","issues_found":2,"unresolved":0,"commit":"f1e3560","note":"see ---HEAD--- below"}`,
      `---CONFIG---`, `false`, `---HEAD---`, `f1e3560`,
    ].join("\n");
    const r = parsePlanReviews(out);
    expect(r.eng).toEqual({ status: "clean", stale: false, detail: "2 issues, 0 unresolved" });
  });

  test("uncommitted / unknown commits are never stale (not comparable)", () => {
    const mk = (commit: string, head: string) =>
      [`{"skill":"plan-eng-review","status":"clean","issues_found":1,"unresolved":0,"commit":"${commit}"}`,
       `---CONFIG---`, `false`, `---HEAD---`, head].join("\n");
    expect(parsePlanReviews(mk("uncommitted", "bbbbbbb")).eng!.stale).toBe(false);
    expect(parsePlanReviews(mk("aaaaaaa", "unknown")).eng!.stale).toBe(false);
    expect(parsePlanReviews(mk("unknown", "bbbbbbb")).eng!.stale).toBe(false);
  });

  test("a non-clean status is 'not-clean' — never invents an 'issues' claim", () => {
    const out = [
      `{"skill":"plan-ceo-review","status":"issues_open","unresolved":9,"commit":"d04fb79"}`,
      `---CONFIG---`, `false`, `---HEAD---`, `d04fb79`,
    ].join("\n");
    // No scope counts here → the generic "ran (not clean)" summary, not a fake count.
    expect(parsePlanReviews(out).ceo).toEqual({ status: "not-clean", stale: false, detail: "ran (not clean)" });
  });

  test("NO_REVIEWS (or an empty log) → all three null", () => {
    const out = [`NO_REVIEWS`, `---CONFIG---`, `false`, `---HEAD---`, `abc1234`].join("\n");
    expect(parsePlanReviews(out)).toEqual({ ceo: null, design: null, eng: null });
    expect(parsePlanReviews("")).toEqual({ ceo: null, design: null, eng: null });
  });

  test("malformed JSON lines are skipped, not fatal", () => {
    const out = [
      `not json at all`,
      `{"skill":"plan-design-review","status":"clean","overall_score":9,"unresolved":0,"commit":"d04fb79"}`,
      `{ broken`,
      `---CONFIG---`, `false`, `---HEAD---`, `d04fb79`,
    ].join("\n");
    const r = parsePlanReviews(out);
    expect(r.design).toEqual({ status: "clean", stale: false, detail: "score 9/10, 0 unresolved" });
    expect(r.eng).toBeNull();
    expect(r.ceo).toBeNull();
  });

  test("tolerates a missing ---HEAD--- section (no marker → head unknown, nothing stale)", () => {
    const out = `{"skill":"plan-eng-review","status":"clean","issues_found":4,"unresolved":1,"commit":"aaaaaaa"}`;
    expect(parsePlanReviews(out).eng).toEqual({ status: "clean", stale: false, detail: "4 issues, 1 unresolved" });
  });

  test("handles the REAL reader format where the ---HEAD--- marker is glued to the config value", () => {
    // `gstack-config get skip_eng_review` prints `false` with no trailing newline,
    // so the live reader emits `false---HEAD---` on one line. HEAD (f1e3560) is the
    // next line, and staleness must still be computed against it (verified live).
    const out = [
      `{"skill":"plan-eng-review","status":"clean","issues_found":11,"unresolved":0,"commit":"f1e3560"}`,
      `{"skill":"plan-design-review","status":"clean","overall_score":8,"unresolved":0,"commit":"deadbee"}`,
      `---CONFIG---`,
      `false---HEAD---`,   // ← glued, the exact shape the real binary produces
      `f1e3560`,
    ].join("\n");
    const r = parsePlanReviews(out);
    expect(r.eng).toEqual({ status: "clean", stale: false, detail: "11 issues, 0 unresolved" });
    expect(r.design).toEqual({ status: "clean", stale: true, detail: "score 8/10, 0 unresolved" }); // deadbee ≠ HEAD
  });
});
