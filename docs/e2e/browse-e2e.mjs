// Browser-driven end-to-end proof of the core loop, with a REAL claude agent.
// Drives the actual dashboard UX (not curl): New task -> agent asks in prose ->
// dashboard flips to `waiting` over WebSocket -> reply in the drawer -> the agent
// resumes (`claude --resume`) -> done -> artifact on disk. Run via run.sh (which
// spins a throwaway target repo + a fresh daemon). Costs a real agent turn.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.AGENTDECK_PORT || '8788';
const DASH = `http://127.0.0.1:${PORT}`;
const SHOTS = join(process.cwd(), 'shots');
mkdirSync(SHOTS, { recursive: true });
const AGENT_TIMEOUT = 240000; // real agent turns are slow + nondeterministic
const log = (m) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p) => fetch(`${DASH}${p}`).then((r) => r.json());
// Match a row by its task id (rendered in .meta) so leftover rows can't false-match.
const rowHas = (id, cls) => `(()=>{const r=[...document.querySelectorAll('.row')].find(x=>x.textContent.includes(${JSON.stringify(id)}));return r&&r.className.split(' ').includes(${JSON.stringify(cls)});})()`;

const PROMPT = `You are working inside a git repo. Do EXACTLY this, in order, and nothing else:
1. FIRST, ask me one question in prose, then STOP your turn immediately (do not use any tools yet): "Which color should I use, blue or green?"
2. WAIT for my answer. Do not create any file before I answer.
3. Once I reply with a color word, create a file named color.txt whose entire contents is exactly that word in lowercase (no trailing newline), then say you are done.`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1160, height: 840 }, colorScheme: 'dark' });
page.on('console', (m) => { if (m.type() === 'error') log(`CONSOLE ERROR: ${m.text()}`); });
try {
  await page.goto(DASH, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('conn')?.textContent === 'live', { timeout: 10000 });
  log('dashboard live');

  await page.click('button.newbtn');                       // "+ New task"
  await page.waitForSelector('#nt', { state: 'visible', timeout: 5000 });
  await page.fill('#nt', 'e2e color test');
  await page.fill('#np', PROMPT);
  await page.screenshot({ path: join(SHOTS, '1-newtask.png') });
  await page.click('#drawer button.btn.primary');          // "Launch agent" (scoped to the drawer)
  log('task launched via browser');

  let taskId;
  for (let i = 0; i < 25 && !taskId; i++) { const { tasks } = await api('/api/tasks'); taskId = tasks[0]?.id; if (!taskId) await sleep(200); }
  if (!taskId) throw new Error('task never appeared (createTask failed?)');
  log(`agent spawned for task ${taskId}; waiting for it to ask...`);

  await page.waitForFunction(rowHas(taskId, 'waiting'), null, { timeout: AGENT_TIMEOUT });
  const q = await page.evaluate(() => document.querySelector('.row.waiting .qprev')?.textContent || '?');
  log(`WAITING — question: ${q}`);
  await page.screenshot({ path: join(SHOTS, '2-waiting.png') });

  await page.click('.row.waiting .btn.primary');           // "Reply"
  await page.waitForSelector('#ans', { state: 'visible', timeout: 5000 });
  await page.fill('#ans', 'blue');
  await page.screenshot({ path: join(SHOTS, '3-reply.png') });
  await page.click('#drawer button.btn.primary');          // "Send to agent" (scoped to the drawer)
  log('answer "blue" sent via drawer; waiting for resume + done...');

  await page.waitForFunction(rowHas(taskId, 'done'), null, { timeout: AGENT_TIMEOUT });
  await page.screenshot({ path: join(SHOTS, '4-done.png') });

  const { diff } = await api(`/api/tasks/${taskId}/diff`);
  if (!diff.includes('color.txt')) throw new Error(`artifact missing from diff view: ${diff}`);
  log(`DONE — dashboard diff shows the artifact: ${diff.trim()}`);
  console.log('E2E_RESULT: OK');
} catch (e) {
  await page.screenshot({ path: join(SHOTS, 'error.png') }).catch(() => {});
  console.log(`E2E_RESULT: FAIL — ${e.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally { await browser.close(); }
