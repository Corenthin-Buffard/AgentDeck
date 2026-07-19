// Pure detection helpers for headless-agent output. No side-effect imports, so
// these are unit-testable in isolation (see test/detect.test.ts).

const QUESTION_CUES =
  /\b(which|choose|should i|do you want|would you like|option|let me know|please (confirm|pick|reply)|reply with|waiting for your (answer|reply)|proceed\?)\b/i;

/**
 * Did the agent stop to ask the human something (prose), vs finish the task?
 * Headless mode has no structured AskUserQuestion, so gstack asks in prose and
 * ends the turn — this decides `waiting` vs `done`. Conservative: looks only at
 * the tail of the message so a mid-answer question mark doesn't trip it.
 */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.trim().slice(-500);
  if (!tail) return false;
  return /\?\s*$/.test(tail) || QUESTION_CUES.test(tail);
}
