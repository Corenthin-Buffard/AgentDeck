#!/usr/bin/env bun
// A dev server that misbehaves on demand.
//
// Every interesting branch in preview.ts is about how a child BEHAVES — it forks a
// grandchild that outlives a naive kill, it binds the wrong address, it exits
// because node_modules is missing, it floods stdout, it never listens at all. None
// of that needs a real Vite or Next install, and testing against one would mean
// network access, hundreds of megabytes per CI run, and a suite that goes red when
// somebody else ships a release.
//
// Same discipline as test/agent-spawn.test.ts, which tests the agent supervisor
// without ever running a real `claude`.
//
//   --port <n>        listen on this port (default: $PORT, else none — never listen).
//                     The env fallback is how a test proves the supervisor's parsed
//                     NAME=VALUE tokens actually REACH the child: a command with no
//                     --port that still listens can only have got the number from
//                     the environment.
//   --host <addr>     bind address (default 127.0.0.1; pass 0.0.0.0 to misbehave)
//   --delay <ms>      wait this long before listening
//   --exit <code>     exit immediately with this code
//   --flood <bytes>   write this many bytes to stdout before listening
//   --stderr <text>   write this to stderr before doing anything else
//   --marker <text>   write this to stdout AFTER the flood, so a test can prove
//                     the supervisor actually CONSUMED stdout rather than infer it
//   --close-after <ms> stop listening but stay alive — the only shape the sweep's
//                     health probe is responsible for (a dead process is caught by
//                     the close handler long before any sweep runs)
//   --exit-after <ms> listen, then EXIT — the only shape that reaches the child's
//                     close handler after the entry is already `ready`
//   --ignore-sigterm  refuse SIGTERM, so the SIGKILL escalation has something to do

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const stderrText = flag("--stderr");
if (stderrText) process.stderr.write(stderrText + "\n");

const exitCode = flag("--exit");
if (exitCode !== undefined) process.exit(Number(exitCode));

const flood = Number(flag("--flood") ?? 0);
if (flood > 0) {
  // Deliberately larger than a 64KiB pipe buffer when the test asks for it: an
  // undrained parent blocks here forever and never reaches listen().
  const chunk = "x".repeat(1024) + "\n";
  for (let written = 0; written < flood; written += chunk.length) process.stdout.write(chunk);
}

const marker = flag("--marker");
if (marker) process.stdout.write(marker + "\n");

if (args.includes("--ignore-sigterm")) process.on("SIGTERM", () => { /* deliberately unkillable by SIGTERM */ });

const delay = Number(flag("--delay") ?? 0);
// $PORT is the fallback a real dev server would use, and the ONLY way this process
// can learn a port when the command carries no --port. A test that asserts this
// listens is therefore asserting that parsePreviewCommand's env actually reached
// the child — the delivery, not just the parse.
const port = flag("--port") ?? process.env.PORT;
const closeAfter = Number(flag("--close-after") ?? 0);
const exitAfter = Number(flag("--exit-after") ?? 0);
// Registered UP FRONT, not inside the timeout: once the listener is stopped there
// is nothing else holding the loop open, and the process would exit — which is the
// close-handler shape, not the stopped-listening shape this flag exists to produce.
if (closeAfter > 0) setInterval(() => { /* stay alive with no listener */ }, 1 << 30);

async function listen() {
  if (port === undefined) {
    // "never listens": stay alive so the supervisor's readiness timeout is what
    // ends this, not the process exiting.
    setInterval(() => { /* keep the loop alive */ }, 1 << 30);
    return;
  }
  const srv = Bun.listen({
    hostname: flag("--host") ?? "127.0.0.1",
    port: Number(port),
    socket: { data() { /* a real dev server would answer; we only need the accept */ } },
  });
  process.stdout.write(`fake-dev-server listening on ${port}\n`);
  // Stop accepting but stay alive. A process that EXITS is caught by the close
  // handler; only this shape reaches the sweep's canConnect probe.
  if (closeAfter > 0) setTimeout(() => srv.stop(true), closeAfter);
  // The mirror image: die once the supervisor has already seen `ready`, which is
  // the only way to reach the child close handler's post-ready branch.
  if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);
}

if (delay > 0) setTimeout(listen, delay);
else void listen();
