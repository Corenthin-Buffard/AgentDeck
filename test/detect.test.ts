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

  // Regression: a heavy gstack skill (/plan-eng-review) emits a long turn that
  // ENDS on a decision brief whose tail is a `Net:` line with no cue word. The
  // 500-char narrow window misses it; the wide structural check must catch it,
  // or the agent is stranded as `done`. (Found via the P2 full-gstack-loop e2e.)
  test("a long turn ending on a labeled decision brief is a question", () => {
    const t =
      "Thanks, scope confirmed as B. Running all four review sections.\n" +
      "x".repeat(1400) + "\n\n" +
      "A) Ship as-is\n  Fine for the happy path but hides the null branch.\n" +
      "B) Add the test (recommended)\n  Closes the gap; about fifteen minutes.\n" +
      "Completeness: A=4/10, B=9/10\n" +
      "Net: one integration test closes the only real gap.";
    expect(looksLikeQuestion(t)).toBe(true);
  });

  // The whole brief exceeds 2000 chars, so the `D—`/`Recommendation:` FRAME at the
  // top is evicted from the tail window. Detection must survive on the BOTTOM
  // markers (options + Net:/Completeness:) alone, else the fix just moved the
  // stranding threshold from 500 to 2000. (Adversarial review F1.)
  test("a >2000-char brief whose frame is evicted still reads as a question", () => {
    const t =
      "**D3 — Test coverage gap**\n" +
      "Recommendation: B — add the error-path test.\n" +
      "x".repeat(2200) + "\n" +
      "A) Ship as-is\n  Fine for the happy path but hides the null branch.\n" +
      "B) Add the test (recommended)\n  Closes the gap; about fifteen minutes.\n" +
      "Completeness: A=4/10, B=9/10\n" +
      "Net: one integration test closes the only real gap.";
    expect(t.length).toBeGreaterThan(2000);
    expect(looksLikeQuestion(t)).toBe(true);
  });

  // Split-chain buckets render bold and inline: `**A) Include**, **B) Defer**…`.
  // The option matcher must see them through the `**`. (Adversarial review F2.)
  test("a split-chain brief with bold inline option labels is a question", () => {
    const t =
      "Here are the split-chain buckets for shipping E1:\n" +
      "**D3.1 — Ship E1?**\n" +
      "**A) Include**, **B) Defer**, **C) Cut**, **D) Hold**\n" +
      "Net: E1 is low-risk, lean Include.";
    expect(looksLikeQuestion(t)).toBe(true);
  });

  test("an explicit 'your picks' / 'reply with the letter' close is a question", () => {
    expect(looksLikeQuestion("x".repeat(900) + "\nThat's the review — I stop here for your picks above.")).toBe(true);
    expect(looksLikeQuestion("x".repeat(900) + "\nDone laying out the tradeoff — reply with the letter you want.")).toBe(true);
  });

  // The split-chain final-confirm step (`D<n>.final`) is a guaranteed end-of-turn ask
  // whose ONLY structural marker is its D-header — no Net:, no Completeness:. The
  // D-header matcher must accept the non-numeric `.final`/`.revise-k` sub-label, or
  // this exact step strands. (Adversarial review F1.)
  test("a split-chain 'D3.final' confirm block (no Net:) is a question", () => {
    const t =
      "Assembled set looks good.\n" +
      "**D3.final — ship E1+E2?**\n" +
      "Note: options differ in kind.\n" +
      "**A) Ship both**, **B) Hold**";
    expect(looksLikeQuestion(t)).toBe(true);
  });

  // Options rendered as a markdown bullet list must still count as labeled options.
  // (Adversarial review F2.)
  test("a brief whose options are a bullet list is a question", () => {
    const t =
      "Reviewed the retry logic.\n" +
      "- A) Ship as-is\n" +
      "- B) Add the retry cap\n" +
      "Net: the cap closes a real hang.";
    expect(looksLikeQuestion(t)).toBe(true);
  });

  // Guard: the article "a" in "reply with a <noun>" must NOT read as option letter A
  // in the WIDE window. (In the narrow 500-tail, the broad `reply with` cue fires by
  // design; this places the phrase past it so only the structural check applies.)
  // (Adversarial review F3.)
  test("'reply with a <noun>' beyond the narrow tail is not a question", () => {
    const t = "Earlier I noted you could reply with a plan, then I proceeded. " +
      "x".repeat(700) + "\nAll four sections are clear. Shipped.";
    expect(looksLikeQuestion(t)).toBe(false);
  });

  // Guard: benign "your pick" prose in a completion must not trip. (Adversarial review F4.)
  test("benign 'your pick' prose in a completion is not a question", () => {
    expect(looksLikeQuestion("x".repeat(900) + "\nThat was your pick to make, and it's done now.")).toBe(false);
  });

  // Defense in depth: a headless BLOCKED message is an agent needing a human.
  test("a headless 'AskUserQuestion unavailable' block reads as waiting", () => {
    expect(looksLikeQuestion("BLOCKED — AskUserQuestion unavailable; no human present.")).toBe(true);
  });

  // Guard the other way: a completed review that summarizes a recommendation but
  // offers no options and asks nothing must NOT be mis-read as waiting.
  test("a completion with a lone 'Recommendation:' summary is not a question", () => {
    const t =
      "x".repeat(900) +
      "\nRecommendation: ship it — all four sections are clear, no findings. Proceeding to /ship.";
    expect(looksLikeQuestion(t)).toBe(false);
  });

  // The dangerous false-positive: a FINISHED review with letter-bulleted findings
  // AND a `Recommendation:` line. Options are present, but no `Net:`/`Completeness:`
  // brief marker → must stay `done`. (Adversarial review F3.)
  test("a completion with letter bullets + a Recommendation summary is not a question", () => {
    const t =
      "Here's what I reviewed:\n" +
      "A) Architecture — clean\n" +
      "B) Tests — all pass\n" +
      "Recommendation: ship it — no blocking findings. Proceeding to /ship.";
    expect(looksLikeQuestion(t)).toBe(false);
  });

  test("a labeled list in a completion (no brief marker, no ask) is not a question", () => {
    const t = "Here's what I did:\nA) fixed the bug\nB) added a test\nC) updated docs.\nAll done, committed.";
    expect(looksLikeQuestion(t)).toBe(false);
  });
});
