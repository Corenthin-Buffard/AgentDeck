// Browser end-to-end proof of the dashboard's CONNECTION STATE MACHINE.
//
// Why this exists separately from browse-e2e.mjs: that one proves the core
// agent loop and costs a real `claude` turn (slow, nondeterministic, billable).
// This one proves only what happens to the header when the daemon goes away and
// comes back — no agent, no cost, deterministic. It was written because those
// states had been verified once by hand and nothing protected them afterwards.
//
// Covers, in order:
//   live (conn-ok) -> daemon killed -> reconnecting… (conn-wait)
//   -> past GIVE_UP_AFTER -> daemon unreachable (conn-err) + ONE screen-reader
//   announcement -> daemon restarted -> live again, with no page reload.
//
// Run: node conn-states-e2e.mjs   (from docs/e2e, after `npm install`)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = process.env.AGENTDECK_PORT || '8792';
const DASH = `http://127.0.0.1:${PORT}`;
const REPO = resolve(process.cwd(), '../..');
const DATA = mkdtempSync(join(tmpdir(), 'agentdeck-conn-e2e-'));
const SHOTS = join(process.cwd(), 'shots');
mkdirSync(SHOTS, { recursive: true });

const log = (m) => console.log(`[conn-e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The client's own constants (public/index.html). Kept in sync by hand; if the
// timings there change, this test's waits must change with them.
const GIVE_UP_AFTER = 8, RECONNECT_MS = 1500, GIVE_UP_MS = 15000;
const TO_GIVE_UP = GIVE_UP_AFTER * RECONNECT_MS + 3000; // threshold + slack
const TO_RECOVER = GIVE_UP_MS + 8000;                   // one backed-off retry + slack

function startDaemon() {
  const p = spawn('bun', ['run', 'src/daemon.ts'], {
    cwd: REPO,
    env: { ...process.env, AGENTDECK_PORT: PORT, AGENTDECK_TARGET_REPO: REPO, AGENTDECK_DATA_DIR: DATA },
    stdio: 'ignore',
    detached: true,
  });
  p.unref();
  return p;
}

async function waitForDaemon(up, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await fetch(`${DASH}/api/tasks`).then(() => true).catch(() => false);
    if (alive === up) return;
    await sleep(250);
  }
  throw new Error(`daemon did not come ${up ? 'up' : 'down'} within ${timeoutMs}ms`);
}

// Read the header's connection element: its text AND its state class, because
// the whole point of the change was that the three states LOOK different.
const connState = () => {
  const el = document.getElementById('conn');
  return el ? { text: el.textContent, cls: el.className } : null;
};

let daemon = null, browser = null, failed = false;
const check = (name, ok, detail) => {
  if (ok) { log(`PASS  ${name}`); return; }
  failed = true;
  log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  log(`data dir ${DATA}`);
  daemon = startDaemon();
  await waitForDaemon(true);
  log('daemon up');

  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1160, height: 840 }, colorScheme: 'dark' });
  page.on('console', (m) => { if (m.type() === 'error') log(`CONSOLE ERROR: ${m.text()}`); });
  await page.goto(DASH, { waitUntil: 'domcontentloaded' });

  // 1. Connected. Also proves the WS token gate lets the real page through —
  //    if the token weren't delivered, this would never reach "live".
  await page.waitForFunction(`(${connState})()?.text === 'live'`, { timeout: 10000 });
  const live = await page.evaluate(connState);
  check('live uses the ok colour', live.cls === 'conn-ok', `class was "${live.cls}"`);
  await page.screenshot({ path: join(SHOTS, 'conn-1-live.png') });

  // 2. Kill the daemon. A restart is routine, so this must read as reconnecting,
  //    NOT as an error — that distinction is the whole feature.
  process.kill(-daemon.pid, 'SIGTERM');
  await waitForDaemon(false);
  log('daemon killed');
  await page.waitForFunction(`(${connState})()?.text === 'reconnecting…'`, { timeout: 10000 });
  const wait = await page.evaluate(connState);
  check('reconnecting uses the wait colour, not the error colour',
    wait.cls === 'conn-wait', `class was "${wait.cls}"`);
  await page.screenshot({ path: join(SHOTS, 'conn-2-reconnecting.png') });

  // 3. Past the threshold it escalates to a real error, and says so once.
  await page.waitForFunction(`(${connState})()?.text === 'daemon unreachable'`, { timeout: TO_GIVE_UP });
  const dead = await page.evaluate(connState);
  check('unreachable uses the error colour', dead.cls === 'conn-err', `class was "${dead.cls}"`);

  const announcements = await page.evaluate(
    () => [...document.getElementById('live').children].map((c) => c.textContent),
  );
  const unreachable = announcements.filter((t) => t === 'Daemon unreachable.');
  check('screen reader is told exactly once, not on every retry',
    unreachable.length === 1, `announced ${unreachable.length}x`);
  await page.screenshot({ path: join(SHOTS, 'conn-3-unreachable.png') });

  // 4. Recovery is automatic and needs no page reload, even after backing off.
  daemon = startDaemon();
  await waitForDaemon(true);
  log('daemon restarted');
  await page.waitForFunction(`(${connState})()?.text === 'live'`, { timeout: TO_RECOVER });
  const back = await page.evaluate(connState);
  check('recovers to live on its own', back.cls === 'conn-ok', `class was "${back.cls}"`);
  await page.screenshot({ path: join(SHOTS, 'conn-4-recovered.png') });
} catch (e) {
  failed = true;
  log(`ERROR ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (daemon?.pid) { try { process.kill(-daemon.pid, 'SIGTERM'); } catch { /* already gone */ } }
}

log(failed ? 'CONNECTION STATE E2E: FAILED' : 'CONNECTION STATE E2E: PASSED');
process.exit(failed ? 1 : 0);
