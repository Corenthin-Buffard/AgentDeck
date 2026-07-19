import type { Phase } from "./types.ts";

// gstack skill → dashboard phase (from the eng review mapping table).
// The stream has no 'run' skill, so 'run' is inferred from Edit/Write activity.
const SKILL_PHASE: Record<string, Phase> = {
  "plan-ceo-review": "plan", "plan-eng-review": "plan", "plan-design-review": "plan",
  "office-hours": "plan", "spec": "plan",
  "review": "review", "design-review": "review", "investigate": "review",
  "qa": "qa", "qa-only": "qa", "browse": "qa", "canary": "qa",
  "ship": "ship", "land-and-deploy": "ship",
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Best-effort phase from a single stream signal. Returns null if inconclusive. */
export function phaseFromSignal(sig: { skill?: string; tool?: string; shipped?: boolean }): Phase | null {
  if (sig.shipped) return "done";
  if (sig.skill && SKILL_PHASE[sig.skill]) return SKILL_PHASE[sig.skill];
  if (sig.tool && EDIT_TOOLS.has(sig.tool)) return "run"; // coding activity
  return null;
}

const ORDER: Phase[] = ["plan", "run", "review", "qa", "ship", "done"];
/** Monotonic-ish merge: don't regress past 'run' back to 'plan' on stray signals. */
export function mergePhase(current: Phase, next: Phase): Phase {
  if (current === "unknown") return next;
  return ORDER.indexOf(next) >= ORDER.indexOf(current) ? next : current;
}
