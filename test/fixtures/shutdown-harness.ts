#!/usr/bin/env bun
// Proves the shutdown handler in a REAL process, which a unit test cannot.
//
// Registering a listener for SIGTERM removes Node's default terminate behaviour.
// From that point the process exits only if our handler says so — and a unit test
// with an injected `exit` stub would happily pass while the shipped daemon hangs
// until systemd's TimeoutStopSec and then gets SIGKILLed, orphaning every agent.
//
// So: install the handler for real, hold the loop open, and let the parent send a
// signal and time how long we take to die.
//
//   --hang    make the preview teardown never resolve, so only the budget can end it
//   --throw   make it reject, so only the `finally` can end it

import { installPreviewShutdown } from "../../src/preview.ts";

const mode = process.argv[2];
const stop = mode === "--hang"
  ? () => new Promise<void>(() => { /* never resolves */ })
  : mode === "--throw"
    ? () => Promise.reject(new Error("teardown blew up"))
    : undefined;

installPreviewShutdown({ stop, budgetMs: 1_000 });

// Hold the event loop open exactly the way a live daemon does.
setInterval(() => { /* keep alive */ }, 1 << 30);
process.stdout.write("ready\n");
