// Test helpers: a scripted OpenAI-compatible model server and throwaway git repos.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// handler({ messages, tools, n }) → { content } | { tool_calls: [{ name, args }] } | { status, body }
function startMockModel(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/version')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      requests.push(payload);
      const out = handler({ messages: payload.messages, tools: payload.tools, n: requests.length, payload });
      if (out.status) {
        res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body || { error: 'mock error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] })}\n\n`);
      if (out.content) send({ content: out.content });
      (out.tool_calls || []).forEach((c, i) => send({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }] }));
      send({}, out.tool_calls?.length ? 'tool_calls' : 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function sh(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-repo-'));
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'config', 'user.email', 't@t');
  sh(dir, 'git', 'config', 'user.name', 't');
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', 'commit', '-q', '-m', 'init');
  return dir;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
}

function config(home, profiles, extra = {}) {
  return {
    home,
    source: 'test',
    profiles: profiles.map((p, i) => ({ name: p.name || `p${i}`, baseUrl: p.url, apiKey: '', model: 'mock', temperature: 0, contextLength: 32768, kind: 'openai', ...p })),
    settings: { webResearch: false },
    maxSteps: 20,
    commandTimeoutMs: 20_000,
    modelRetries: 0,
    modelBackoffMs: 10,
    ...extra
  };
}

module.exports = { startMockModel, makeRepo, sh, tmpHome, config };
