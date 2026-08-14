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
//   --port <n>        listen on this port (default: none, i.e. never listen)
//   --host <addr>     bind address (default 127.0.0.1; pass 0.0.0.0 to misbehave)
//   --delay <ms>      wait this long before listening
//   --exit <code>     exit immediately with this code
//   --flood <bytes>   write this many bytes to stdout before listening
//   --stderr <text>   write this to stderr before doing anything else

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

const delay = Number(flag("--delay") ?? 0);
const port = flag("--port");

async function listen() {
  if (port === undefined) {
    // "never listens": stay alive so the supervisor's readiness timeout is what
    // ends this, not the process exiting.
    setInterval(() => { /* keep the loop alive */ }, 1 << 30);
    return;
  }
  Bun.listen({
    hostname: flag("--host") ?? "127.0.0.1",
    port: Number(port),
    socket: { data() { /* a real dev server would answer; we only need the accept */ } },
  });
  process.stdout.write(`fake-dev-server listening on ${port}\n`);
}

if (delay > 0) setTimeout(listen, delay);
else void listen();
