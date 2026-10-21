// The real thing end to end: an MCP client talks to `qwen-agent mcp` over stdio, delegates a
// task, the detached job runs against a scripted model, and the result comes back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { startMockModel, makeRepo, sh, tmpHome } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'qwen-agent.js');
const toolResults = (messages) => messages.filter((m) => m.role === 'tool').length;
const parse = (r) => JSON.parse(r.content[0].text);

test('Claude → MCP delegate_task → detached job → get_result', async () => {
  const repo = makeRepo({ 'answer.txt': '0\n', 'check.js': "if(require('fs').readFileSync('answer.txt','utf8').trim()!=='42')process.exit(1)\n" });
  const home = tmpHome();
  const model = await startMockModel(({ messages }) =>
    toolResults(messages) === 0 ? { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] } : { content: 'Done: answer.txt is 42.' }
  );
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: [{ name: 'mock', baseUrl: model.url, model: 'mock', kind: 'openai', contextLength: 32768 }], webResearch: false }));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, QWEN_AGENT_HOME: home } }));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['cancel_task', 'delegate_task', 'get_result', 'list_tasks']);

    const started = parse(await client.callTool({ name: 'delegate_task', arguments: { repo, title: 'Set answer', task: 'Make answer.txt contain 42.', gates: [{ name: 'check', run: 'node check.js' }] } }));
    assert.equal(started.status, 'starting');
    assert.ok(started.id);

    let res;
    for (let i = 0; i < 60; i++) {
      res = parse(await client.callTool({ name: 'get_result', arguments: { id: started.id } }));
      if (res.branch && res.gates) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(res.status, 'passed', JSON.stringify(res));
    assert.equal(res.diff, undefined, 'diff is omitted unless asked for');
    assert.match(res.diff_note, /include_diff/);
    assert.equal(sh(repo, 'git', 'show', `${res.branch}:answer.txt`).trim(), '42');

    const withDiff = parse(await client.callTool({ name: 'get_result', arguments: { id: started.id, include_diff: true } }));
    assert.match(withDiff.diff, /\+42/);

    const list = parse(await client.callTool({ name: 'list_tasks', arguments: {} }));
    assert.equal(list[0].id, started.id);

    const bad = await client.callTool({ name: 'delegate_task', arguments: { repo: home, task: 'x' } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    await model.close();
  }
});

test('wait_seconds returns the finished result in one call for a quick task', async () => {
  const repo = makeRepo({ 'a.txt': '1\n' });
  const home = tmpHome();
  const model = await startMockModel(({ messages }) =>
    toolResults(messages) === 0 ? { tool_calls: [{ name: 'write_file', args: { path: 'a.txt', content: '2\n' } }] } : { content: 'ok' }
  );
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: [{ baseUrl: model.url, model: 'mock', kind: 'openai' }], webResearch: false }));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, QWEN_AGENT_HOME: home } }));
  try {
    const r = parse(await client.callTool({ name: 'delegate_task', arguments: { repo, task: 'Change a.txt to 2.', gates: [{ run: 'node -e "process.exit(0)"' }], wait_seconds: 60 } }));
    assert.equal(r.status, 'passed', JSON.stringify(r));
  } finally {
    await client.close();
    await model.close();
  }
});

test('CLI: init writes a sample config; check reports a dead model clearly', async () => {
  const { execFileSync, spawnSync } = require('child_process');
  const home = tmpHome();
  const env = { ...process.env, QWEN_AGENT_HOME: home, OPENROUTER_API_KEY: '' };
  assert.match(execFileSync(process.execPath, [CLI, 'init'], { env, encoding: 'utf8' }), /Wrote/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.profiles[0].apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(cfg.profiles[0].apiKey, undefined, 'the sample never holds a key itself');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: [{ name: 'dead', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', kind: 'openai' }] }));
  const r = spawnSync(process.execPath, [CLI, 'check'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ dead/);
});

test('a job whose process dies before starting (no model configured) shows up as crashed with the reason', async () => {
  const repo = makeRepo({ 'a.txt': '1\n' });
  const home = tmpHome(); // no config.json, and no desktop-app settings visible
  const env = { ...process.env, QWEN_AGENT_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home };
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env }));
  try {
    const started = parse(await client.callTool({ name: 'delegate_task', arguments: { repo, task: 'x' } }));
    let res;
    for (let i = 0; i < 40; i++) {
      res = parse(await client.callTool({ name: 'get_result', arguments: { id: started.id } }));
      if (res.status === 'crashed') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(res.status, 'crashed');
    assert.match(res.note, /No model configured/);
  } finally {
    await client.close();
  }
});
