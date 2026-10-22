// Agent-loop smoke test: a scripted OpenAI-compatible server stands in for the model and
// issues a real tool call. Proves the whole pipeline — settings UI, streaming, tool-call
// assembly, execution, follow-up turn, completion — with no human and no real model.
// Run under a display: xvfb-run -a npm run test:e2e:agent
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`AGENT SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-agent-'));
const madeFile = path.join(ws, 'smoke-made.txt');

// ---- scripted model ----
let requests = 0;
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end('{}');
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    requests++;
    // The very first request is answered with a 503, so the loop's busy-model retry must kick
    // in for the task to complete at all.
    if (requests === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"code":503,"status":"UNAVAILABLE","message":"high demand"}}');
    }
    const hasToolResult = body.includes('"role":"tool"');
    if (!hasToolResult) {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'smoke-made.txt', content: 'made by the agent loop\n' }) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ]);
    } else {
      sse(res, [
        { choices: [{ delta: { content: 'Done. I created smoke-made.txt.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ]);
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  // Configure the scripted model through the real Settings UI (so state and disk both update).
  await win.evaluate((baseUrl) => {
    openSettings();
    document.querySelector('#s-provider').value = 'custom';
    document.querySelector('#s-baseUrl').value = baseUrl;
    document.querySelector('#s-apiKey').value = '';
    document.querySelector('#s-model').value = 'mock-model';
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-approvalMode').value = 'auto';
    return document.querySelector('#s-save').onclick();
  }, base);

  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);
  await win.evaluate(() => {
    document.querySelector('#prompt').value = 'make the smoke file';
    document.querySelector('#btn-send').onclick();
  });

  // The loop should execute the scripted write_file and then finish with the text turn.
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(madeFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(madeFile)) fail('the agent loop never wrote smoke-made.txt');
  else if (!fs.readFileSync(madeFile, 'utf8').includes('made by the agent loop')) fail('smoke-made.txt has the wrong content');

  await win.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .md')].some((e) => e.textContent.includes('Done. I created smoke-made.txt.')), null, { timeout: 15_000 }).catch(() => fail('the final assistant turn never rendered'));
  if (requests < 3) fail(`expected 3 model requests (503, tool turn, final), saw ${requests}`);
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await app.close().catch(() => {});
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`agent smoke ok: ${requests} model requests (incl. one 503 retried), tool executed, file written, final answer rendered`);
