const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runTask, readJob } = require('../src/core/runner');
const { parseSpec } = require('../src/core/spec');
const { startMockModel, makeRepo, sh, tmpHome, config } = require('./helpers');

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content || '';
const toolResults = (messages) => messages.filter((m) => m.role === 'tool').length;

const GATE = 'node check.js';
const baseFiles = {
  'check.js': "const fs=require('fs');const v=fs.readFileSync('answer.txt','utf8').trim();if(v!=='42'){console.error('expected 42 got '+v);process.exit(1)}console.log('ok')\n",
  'answer.txt': '0\n'
};
const spec = (extra = '') => parseSpec(`---\ntitle: Set the answer\ngates:\n  - name: check\n    run: ${GATE}\n${extra}---\nMake answer.txt contain 42.`);

test('happy path: agent edits, gate passes, work is committed on its own branch', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const model = await startMockModel(({ messages }) =>
    toolResults(messages) === 0
      ? { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] }
      : { content: 'Set answer.txt to 42. No assumptions.' }
  );
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ url: model.url, apiKey: 'sk-SECRET-123' }]) });
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.match(r.branch, /^qwen\/set-the-answer-/);
    for (const f of fs.readdirSync(path.join(home, 'jobs', r.id))) {
      assert.ok(!fs.readFileSync(path.join(home, 'jobs', r.id, f), 'utf8').includes('sk-SECRET-123'), `${f} must not contain the API key`);
    }
    assert.equal(r.gates[0].passed, true);
    assert.deepEqual(r.files.map((f) => [f.path, f.status]), [['answer.txt', 'M']]);
    assert.match(r.diff, /\+42/);
    assert.match(r.summary, /Set answer.txt/);
    assert.equal(r.fix_rounds, 0);
    // the branch holds the commit; the user's checkout was never touched
    assert.equal(sh(repo, 'git', 'show', `${r.branch}:answer.txt`).trim(), '42');
    assert.equal(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8').trim(), '0');
    assert.equal(sh(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.equal(fs.existsSync(path.join(home, 'work', r.id)), false, 'worktree removed');
    // job files are readable afterwards
    assert.equal(readJob(home, r.id).result.status, 'passed');
    assert.ok(fs.readFileSync(path.join(home, 'jobs', r.id, 'events.jsonl'), 'utf8').includes('"type":"gates"'));
  } finally {
    await model.close();
  }
});

test('failing gate is sent back with its output and the agent fixes it', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const seenGatePrompt = [];
  const model = await startMockModel(({ messages }) => {
    const u = lastUser(messages);
    if (/automatic checks failed/.test(u)) {
      seenGatePrompt.push(u);
      return toolResults(messages) >= 2 && messages[messages.length - 1].role === 'tool'
        ? { content: 'Fixed.' }
        : { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] };
    }
    if (toolResults(messages) === 0) return { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '41\n' } }] };
    return { content: 'Done (wrongly).' };
  });
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ url: model.url }]) });
    assert.equal(r.status, 'passed', JSON.stringify(r, null, 1));
    assert.equal(r.fix_rounds, 1);
    assert.match(seenGatePrompt[0], /expected 42 got 41/);
    assert.match(seenGatePrompt[0], /do not weaken, skip or delete tests/);
    assert.equal(sh(repo, 'git', 'show', `${r.branch}:answer.txt`).trim(), '42');
  } finally {
    await model.close();
  }
});

test('gates that never pass end as gates_failed after max_fix_rounds, work kept as WIP', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const model = await startMockModel(({ messages }) =>
    messages[messages.length - 1].role === 'tool' ? { content: 'Done.' } : { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: `${Date.now()}\n` } }] }
  );
  try {
    const r = await runTask({ repo, spec: spec('max_fix_rounds: 2\n'), config: config(home, [{ url: model.url }]) });
    assert.equal(r.status, 'gates_failed');
    assert.equal(r.fix_rounds, 2);
    assert.equal(r.gates[0].passed, false);
    assert.match(r.gates[0].output_tail, /expected 42/);
    assert.equal(r.merge_hint, undefined, 'no merge hint for failing work');
    assert.match(sh(repo, 'git', 'log', '-1', '--format=%s', r.branch), /^WIP \(gates_failed\)/);
  } finally {
    await model.close();
  }
});

test('report_blocked ends the run as blocked with the reason, and leaves no empty branch', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const model = await startMockModel(() => ({ tool_calls: [{ name: 'report_blocked', args: { reason: 'Spec says 42 but check.js wants 43.' } }] }));
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ url: model.url }]) });
    assert.equal(r.status, 'blocked');
    assert.match(r.blocked_reason, /wants 43/);
    assert.equal(r.branch, null);
    assert.equal(sh(repo, 'git', 'branch', '--list', 'qwen/*').trim(), '');
  } finally {
    await model.close();
  }
});

test('allow_paths: a write outside them is refused and the agent can still finish inside', async () => {
  const repo = makeRepo({ ...baseFiles, 'src/x.js': '1\n' });
  const home = tmpHome();
  const model = await startMockModel(({ messages }) => {
    const n = toolResults(messages);
    if (n === 0) return { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] };
    return { content: 'Tried.' };
  });
  try {
    const r = await runTask({ repo, spec: spec('allow_paths:\n  - src/\nmax_fix_rounds: 0\n'), config: config(home, [{ url: model.url }]) });
    assert.equal(r.status, 'gates_failed');
    assert.equal(r.files.length, 0);
    assert.equal(sh(repo, 'git', 'branch', '--list', 'qwen/*').trim(), '', 'no changes → no branch kept');
  } finally {
    await model.close();
  }
});

test('model fallback: a dead hosted profile (bad key) hands over to the local one', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const hosted = await startMockModel(() => ({ status: 401, body: { error: 'invalid api key' } }));
  const local = await startMockModel(({ messages }) =>
    toolResults(messages) === 0 ? { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] } : { content: 'ok' }
  );
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ name: 'hosted', url: hosted.url }, { name: 'local', url: local.url }]) });
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.fallback_used, true);
    assert.equal(r.profile, 'local');
    assert.equal(hosted.requests.length, 1, 'permanent errors are not retried, and later steps skip the dead profile');
    assert.ok(local.requests.length >= 2);
    const events = fs.readFileSync(path.join(home, 'jobs', r.id, 'events.jsonl'), 'utf8');
    assert.match(events, /"type":"fallback"/);
  } finally {
    await hosted.close();
    await local.close();
  }
});

test('transient errors (503) are retried on the same profile before falling back', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  let hits = 0;
  const model = await startMockModel(({ messages }) => {
    hits++;
    if (hits === 1) return { status: 503, body: { error: 'overloaded' } };
    return toolResults(messages) === 0 ? { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] } : { content: 'ok' };
  });
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ url: model.url }], { modelRetries: 2 }) });
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.fallback_used, false);
  } finally {
    await model.close();
  }
});

test('every profile failing is reported as an error, not a hang', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const dead = await startMockModel(() => ({ status: 401, body: {} }));
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ url: dead.url }]) });
    assert.equal(r.status, 'error');
    assert.match(r.error, /HTTP 401/);
    assert.equal(r.branch, null);
  } finally {
    await dead.close();
  }
});

test('rejects a folder that is not a git repo, and a bad base', async () => {
  const home = tmpHome();
  const notRepo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qa-plain-'));
  let r = await runTask({ repo: notRepo, spec: spec(), config: config(home, [{ url: 'http://127.0.0.1:1/v1' }]) });
  assert.equal(r.status, 'rejected');
  const repo = makeRepo(baseFiles);
  r = await runTask({ repo, spec: spec('base: nonexistent\n'), config: config(home, [{ url: 'http://127.0.0.1:1/v1' }]) });
  assert.equal(r.status, 'rejected');
  assert.match(r.error, /nonexistent/);
});

test('uncommitted changes in the repo are noted, not silently used', async () => {
  const repo = makeRepo(baseFiles);
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'dirty\n');
  const home = tmpHome();
  const model = await startMockModel(({ messages }) =>
    toolResults(messages) === 0 ? { tool_calls: [{ name: 'write_file', args: { path: 'answer.txt', content: '42\n' } }] } : { content: 'ok' }
  );
  try {
    const r = await runTask({ repo, spec: spec(), config: config(home, [{ url: model.url }]) });
    assert.equal(r.status, 'passed');
    assert.ok(r.notes.some((n) => /uncommitted changes/.test(n)));
    assert.equal(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8'), 'dirty\n', 'the user\'s dirty file is untouched');
  } finally {
    await model.close();
  }
});

test('setup commands run first in the worktree; a failing one stops the job', async () => {
  const repo = makeRepo(baseFiles);
  const home = tmpHome();
  const model = await startMockModel(() => ({ content: 'unused' }));
  try {
    const r = await runTask({ repo, spec: spec('setup:\n  - node -e "process.exit(3)"\n'), config: config(home, [{ url: model.url }]) });
    assert.equal(r.status, 'setup_failed');
    assert.equal(model.requests.length, 0);
  } finally {
    await model.close();
  }
});
