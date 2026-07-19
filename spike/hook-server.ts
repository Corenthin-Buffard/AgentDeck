// gorch spike — HTTP hook receiver.
//
// Claude Code (2026) can POST hook events to a local server instead of running
// a shell script. This is the native IPC the daemon will use in prod. Here it
// just logs what arrives so we can SEE the two signals gorch depends on:
//   - PreToolUse(AskUserQuestion) → the agent is about to ask the human
//   - Notification(*)             → the agent needs attention (any cause)
//
// Caveat proven by the spike: the hook payload carries tool NAME + INPUT only,
// never the tool RESULT. So the hook tells us "a question is coming" and gives
// us the options, but ANSWERING happens over the agent's stdin (see run.ts),
// not by returning a value here.
//
//   run:  bun run spike/hook-server.ts   (listens on :8080)

const PORT = Number(process.env.GORCH_HOOK_PORT ?? 8080);

function log(tag: string, obj: unknown) {
  console.log(`\n── HOOK ${tag} ${"─".repeat(40)}`);
  console.log(JSON.stringify(obj, null, 2));
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let body: any = null;
    try { body = await req.json(); } catch { /* empty */ }

    if (url.pathname === "/hooks/pre-tool-use") {
      log("PreToolUse", { tool: body?.tool_name, input: body?.tool_input, session: body?.session_id });
      // Allow the tool through. We do NOT answer the question here — the daemon
      // notifies the human and injects the answer over stdin (run.ts).
      return Response.json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "gorch: observed, human loop handled over stdin",
        },
      });
    }

    if (url.pathname === "/hooks/notification") {
      log("Notification", { message: body?.message, session: body?.session_id });
      // This is the first-class "agent needs you" signal → in prod, fan out to
      // Slack + Telegram here (notification-only).
      return new Response(null, { status: 204 });
    }

    return new Response("gorch hook server", { status: 200 });
  },
});

console.log(`gorch hook server listening on http://localhost:${PORT}`);
console.log("  POST /hooks/pre-tool-use   (PreToolUse:AskUserQuestion)");
console.log("  POST /hooks/notification   (Notification:*)");
