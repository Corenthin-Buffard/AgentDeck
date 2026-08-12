import type { Phase } from "./types.ts";

// gstack skill → dashboard phase.
// The stream has no 'run' skill, so 'run' is inferred from Edit/Write activity.
//
// AUTHORITATIVE vs INFERRED — the invariant that keeps the bar honest:
//
//   /spec ─────────────▶ plan        a skill reporting its own phase
//     │
//     └─ writes the spec file ─▶ Edit ─▶ run        only a guess
//                                         │
//   /autoplan ─▶ plan  ───────────────────┘  must be able to move BACK to plan
//
// A skill knows which phase it is in; an edit is only guessing. While mergePhase
// was strictly forward-only, the Edit that /spec makes writing its own spec file
// pushed the bar to `run`, and every later plan-phase skill was rejected as a
// regression — so the plan segment stayed dark for the whole planning phase.
//
// Not every skill is authoritative. `investigate`, `design-review` and `browse`
// are ad-hoc: an agent debugging something during /ship has not gone back to the
// review phase, so those may only ever move the bar forward.
export interface PhaseSignal {
  phase: Phase;
  /** May this signal move the phase BACKWARD? True only for skills that mark a
   *  genuine pipeline position. See mergePhase. */
  authoritative: boolean;
}

/** skill → phase + authoritative-ness. Exported so a test can assert that every
 *  skill named in the pipeline step table is one the board can actually see. */
export const SKILL_PHASE: Record<string, PhaseSignal> = {
  // ── plan ──
  "spec":               { phase: "plan",   authoritative: true },
  "office-hours":       { phase: "plan",   authoritative: true },
  "autoplan":           { phase: "plan",   authoritative: true },
  "plan-ceo-review":    { phase: "plan",   authoritative: true },
  "plan-eng-review":    { phase: "plan",   authoritative: true },
  "plan-design-review": { phase: "plan",   authoritative: true },
  // ── review ──
  "review":             { phase: "review", authoritative: true },
  "design-review":      { phase: "review", authoritative: false }, // polish, can run late
  "investigate":        { phase: "review", authoritative: false }, // ad-hoc debugging
  // ── qa ──
  "qa":                 { phase: "qa",     authoritative: true },
  "qa-only":            { phase: "qa",     authoritative: true },
  "browse":             { phase: "qa",     authoritative: false }, // a generic browsing tool
  // ── ship ──
  "ship":               { phase: "ship",   authoritative: true },
  "land-and-deploy":    { phase: "ship",   authoritative: true },
  // /canary is POST-deploy: the last step of the pipeline, not a QA step.
  // Mapping it to `qa` meant a canary running after /ship was swallowed by the
  // forward-only merge, so the final step never showed on the board.
  "canary":             { phase: "ship",   authoritative: true },
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Skill names arrive bare today (`"careful"`, verified against a real
 *  stream-json capture), but plugin skills are `plugin:skill` and directory
 *  -scoped ones carry a path prefix. Strip to the last segment so a qualified
 *  name can never silently miss the map. */
export function normalizeSkill(name: string): string {
  const cut = Math.max(name.lastIndexOf(":"), name.lastIndexOf("/"));
  return cut >= 0 ? name.slice(cut + 1) : name;
}

/** `/review --fix` → `review`. An agent may type a slash command instead of
 *  calling the Skill tool; that surfaces as a SlashCommand tool_use carrying the
 *  raw command line, with no Skill block anywhere in the turn. */
export function slashToSkill(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return normalizeSkill(first.replace(/^\/+/, ""));
}

/** Best-effort phase from a single stream signal. Returns null if inconclusive. */
export function phaseFromSignal(sig: { skill?: string; tool?: string; shipped?: boolean }): PhaseSignal | null {
  if (sig.shipped) return { phase: "done", authoritative: true };
  if (sig.skill) {
    const hit = SKILL_PHASE[normalizeSkill(sig.skill)];
    if (hit) return hit;
  }
  // Coding activity. Only ever a guess, so it must not overrule a skill.
  if (sig.tool && EDIT_TOOLS.has(sig.tool)) return { phase: "run", authoritative: false };
  return null;
}

/** Pipeline order, exported so the step-table parser cannot drift from it. */
export const ORDER: Phase[] = ["plan", "run", "review", "qa", "ship", "done"];

/**
 * Merge a new signal into the current phase.
 *
 * An INFERRED signal (`authoritative: false`) may only move FORWARD — the
 * original monotonic guard, which still stops a stray Edit from dragging a
 * shipping task backwards. An AUTHORITATIVE signal may move in either
 * direction, because a skill reporting its own phase is better evidence than
 * anything inferred earlier.
 */
export function mergePhase(current: Phase, next: Phase, authoritative = false): Phase {
  if (current === "unknown") return next;
  if (authoritative) return next;
  return ORDER.indexOf(next) >= ORDER.indexOf(current) ? next : current;
}

/** True while a task is early enough (unknown/plan/run/review) that polling its
 *  plan-review log is still meaningful. Past `review` (qa/ship/done) the plan is
 *  locked, so we stop re-reading. `unknown` (index -1) passes naturally. */
export function canStillReview(phase: Phase): boolean {
  return ORDER.indexOf(phase) <= ORDER.indexOf("review");
}
