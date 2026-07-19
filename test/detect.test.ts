import { expect, test, describe } from "bun:test";
import { looksLikeQuestion } from "../src/detect.ts";

describe("looksLikeQuestion", () => {
  test("detects a trailing question mark", () => {
    expect(looksLikeQuestion("Which color should I use?")).toBe(true);
  });

  test("detects prose cues without a trailing '?'", () => {
    expect(looksLikeQuestion("Please pick one of A, B, or C and let me know.")).toBe(true);
    expect(looksLikeQuestion("Reply with A, B, or C.")).toBe(true);
  });

  test("a bare 'option' cue counts (regression guard: don't strand a waiting agent as done)", () => {
    expect(looksLikeQuestion("Select an option to continue.")).toBe(true);
  });

  test("treats a completion statement as not-a-question", () => {
    expect(looksLikeQuestion("Done. Shipped v1.2.0 and opened the PR.")).toBe(false);
  });

  test("empty / whitespace is not a question", () => {
    expect(looksLikeQuestion("")).toBe(false);
    expect(looksLikeQuestion("   \n ")).toBe(false);
  });

  test("a question mark far from the end does NOT trip it", () => {
    const t = "Is this right? " + "x".repeat(600) + " all finished, nothing left.";
    expect(looksLikeQuestion(t)).toBe(false);
  });

  test("a question at the very end trips it even after long output", () => {
    const t = "x".repeat(600) + "\nSo, which option do you want?";
    expect(looksLikeQuestion(t)).toBe(true);
  });
});
