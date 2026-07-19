import { expect, test, describe } from "bun:test";
import { phaseFromSignal, mergePhase } from "../src/phase.ts";

describe("phaseFromSignal", () => {
  test("maps a gstack skill to its phase", () => {
    expect(phaseFromSignal({ skill: "plan-eng-review" })).toBe("plan");
    expect(phaseFromSignal({ skill: "review" })).toBe("review");
    expect(phaseFromSignal({ skill: "qa" })).toBe("qa");
    expect(phaseFromSignal({ skill: "ship" })).toBe("ship");
  });

  test("edit/write tools imply the Run phase (no gstack 'run' skill exists)", () => {
    expect(phaseFromSignal({ tool: "Edit" })).toBe("run");
    expect(phaseFromSignal({ tool: "Write" })).toBe("run");
  });

  test("shipped flag wins", () => {
    expect(phaseFromSignal({ shipped: true })).toBe("done");
  });

  test("unknown signal returns null", () => {
    expect(phaseFromSignal({ tool: "Bash" })).toBeNull();
    expect(phaseFromSignal({ skill: "nope" })).toBeNull();
    expect(phaseFromSignal({})).toBeNull();
  });
});

describe("mergePhase", () => {
  test("takes next when current is unknown", () => {
    expect(mergePhase("unknown", "run")).toBe("run");
  });

  test("advances forward", () => {
    expect(mergePhase("plan", "review")).toBe("review");
    expect(mergePhase("run", "ship")).toBe("ship");
  });

  test("does not regress backward on a stray signal", () => {
    expect(mergePhase("review", "plan")).toBe("review");
    expect(mergePhase("run", "plan")).toBe("run");
  });

  test("stays put on the same phase", () => {
    expect(mergePhase("qa", "qa")).toBe("qa");
  });
});
