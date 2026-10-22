// Boot smoke test: launches the real app and fails on any renderer error.
// This is what catches a top-level throw in app.js (e.g. a const used before its definition),
// which otherwise leaves the app half-dead: buttons unwired, settings that won't open, a send
// button that does nothing. Run under a display: xvfb-run -a npm run test:e2e
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-smoke-'));
fs.writeFileSync(path.join(ws, 'hello.txt'), 'hi\n');

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

try {
  // Boot must complete: the settings button is wired near the end of bindUi, and the model
  // name is written by applySettingsToUi, which runs after the scheduler/splitters/layout.
  await win.waitForFunction(
    () => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent,
    null,
    { timeout: 25_000 }
  );

  const probe = await win.evaluate(() => ({
    splitters: document.querySelectorAll('.splitter').length,
    schedule: typeof window.Schedule,
    toolParse: typeof window.ToolParse
  }));
  if (probe.splitters < 3) fail(`expected 3 splitters, got ${probe.splitters}`);
  if (probe.schedule !== 'object') fail('schedule.js did not load');
  if (probe.toolParse !== 'object') fail('toolparse.js did not load');

  // Settings must open and close.
  await win.evaluate(() => document.querySelector('#btn-settings').onclick());
  if (await win.evaluate(() => document.querySelector('#settings-modal').classList.contains('hidden'))) fail('settings modal did not open');
  await win.evaluate(() => document.querySelector('#s-cancel').onclick());

  // A conversation must accept a message: clicking send renders the user bubble even when no
  // model server is reachable (the turn then fails with an error card, which is fine).
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  if (!(await win.evaluate(() => document.querySelector('#conv-model-label').textContent))) fail('model chip label is empty');
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'smoke test message';
    document.querySelector('#btn-send').onclick();
  });
  await win.waitForSelector('.msg.user', { timeout: 5000 }).catch(() => fail('clicking send did not render the message'));
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await app.close().catch(() => {});
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('smoke ok: boot clean, settings open, splitters present, send works');
