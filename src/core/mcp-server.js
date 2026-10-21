// MCP server (stdio) so Claude can delegate coding tasks to the Qwen agent:
//   delegate_task → starts a detached job and returns its id (or waits briefly for it)
//   get_result    → status while running; the structured result (+ optional diff) when done
//   list_tasks / cancel_task
// Jobs run as separate processes (bin/qwen-agent.js run --detach), so a slow task never
// blocks the MCP connection and survives the client restarting.
//
// Register it with Claude Code, for example:
//   claude mcp add qwen-agent -- node /path/to/Qwen-3-Coder/bin/qwen-agent.js mcp
// Optional: QWEN_AGENT_REPOS="C:\\repos\\A;C:\\repos\\B" limits which repositories may be used.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { agentHome } = require('./config');
const { readJob, listJobs, lastEvents, newJobId, jobDir } = require('./runner');

const CLI = path.join(__dirname, '..', '..', 'bin', 'qwen-agent.js');
const FINISHED = new Set(['passed', 'gates_failed', 'blocked', 'error', 'incomplete', 'stopped', 'setup_failed', 'rejected', 'no_changes', 'crashed']);

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function repoAllowed(repo) {
  const list = (process.env.QWEN_AGENT_REPOS || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const real = fs.realpathSync(repo);
  return list.some((r) => {
    try {
      return fs.realpathSync(r) === real;
    } catch {
      return false;
    }
  });
}

function view(job, { includeDiff }) {
  const { status, result } = job;
  if (!result) {
    const out = { id: status.id, status: status.status, title: status.title, branch: status.branch, fix_rounds: status.fix_rounds, started: status.started };
    if (status.note) out.note = status.note;
    out.recent_events = lastEvents(agentHome(), status.id, 8).map((e) => e.type === 'tool' ? `${e.name}${e.failed ? ' (failed)' : ''}` : e.type === 'model' ? `step ${e.step}` : e.type);
    return out;
  }
  const r = { ...result };
  if (!includeDiff) {
    delete r.diff;
    r.diff_note = `Diff omitted. Call get_result with include_diff=true, or run: ${result.review_hint || '(no changes)'}`;
  }
  return r;
}

async function start() {
  const home = agentHome();
  const server = new McpServer({ name: 'qwen-agent', version: '1.0.0' });

  server.registerTool(
    'delegate_task',
    {
      description:
        'Hand a well-specified coding task to the Qwen agent. It works in an isolated git worktree on its own branch (your checkout is untouched), runs the gate commands you give, fixes failures itself for a few rounds, then commits and reports. Returns a job id immediately; poll with get_result. Write the task like a spec: files to touch, the contract to follow, what "done" means. Always pass gates (test/lint commands) so the result is verifiable.',
      inputSchema: {
        repo: z.string().describe('Absolute path of the git repository.'),
        task: z.string().describe('The spec: what to build or change and what done means.'),
        title: z.string().optional().describe('Short title; used for the branch name.'),
        gates: z.array(z.object({ name: z.string().optional(), run: z.string(), timeout: z.number().optional().describe('Seconds, default 600') })).optional().describe('Commands that must exit 0 (tests, syntax checks). Run automatically after the agent finishes.'),
        allow_paths: z.array(z.string()).optional().describe('If set, the agent may only create/change files under these paths.'),
        setup: z.array(z.string()).optional().describe('Commands run in the fresh worktree before the agent starts (e.g. dependency install).'),
        max_steps: z.number().optional(),
        max_fix_rounds: z.number().optional().describe('How many times failing gates are sent back for a fix. Default 3.'),
        base: z.string().optional().describe('Branch or commit to start from. Default: the repo HEAD.'),
        wait_seconds: z.number().optional().describe('Wait up to this many seconds (max 90) for a quick task to finish before returning.')
      }
    },
    async (a) => {
      try {
        const repo = path.resolve(a.repo);
        if (!fs.existsSync(path.join(repo, '.git'))) return fail(`${repo} is not the root of a git repository.`);
        if (!repoAllowed(repo)) return fail(`${repo} is not in QWEN_AGENT_REPOS.`);
        const id = newJobId();
        const dir = jobDir(home, id);
        fs.mkdirSync(dir, { recursive: true });
        const specFile = path.join(dir, 'input.json');
        fs.writeFileSync(specFile, JSON.stringify({ title: a.title, task: a.task, gates: a.gates, setup: a.setup, allow_paths: a.allow_paths, max_steps: a.max_steps, max_fix_rounds: a.max_fix_rounds, base: a.base }, null, 2));
        const logFd = fs.openSync(path.join(dir, 'runner.log'), 'a');
        const child = spawn(process.execPath, [CLI, 'run', specFile, '--repo', repo, '--id', id], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: process.env });
        child.unref();
        const deadline = Date.now() + Math.min(90, Math.max(0, a.wait_seconds || 0)) * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const j = readJob(home, id);
          if (j && (j.result || FINISHED.has(j.status.status))) return text(view(j, { includeDiff: false }));
        }
        return text({ id, status: 'starting', next: `Call get_result with id "${id}" to check progress.` });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    'get_result',
    {
      description: 'Status of a delegated task; when finished, the structured result: status (passed / gates_failed / blocked / incomplete / error), branch, files changed, gate results, the agent\'s summary and assumptions. Review the diff before merging; the branch is ready for `git merge` only when status is "passed".',
      inputSchema: { id: z.string(), include_diff: z.boolean().optional().describe('Include the full unified diff (can be large).') }
    },
    async ({ id, include_diff }) => {
      const j = readJob(home, id);
      if (!j) return fail(`No job "${id}".`);
      return text(view(j, { includeDiff: !!include_diff }));
    }
  );

  server.registerTool('list_tasks', { description: 'Recent delegated tasks and their states.', inputSchema: { limit: z.number().optional() } }, async ({ limit }) => text(listJobs(home, { limit: limit || 15 })));

  server.registerTool(
    'cancel_task',
    { description: 'Stop a running delegated task. On macOS/Linux the agent commits what it has and reports status "stopped"; on Windows it is a hard stop (no commit; run `qwen-agent clean` afterwards).', inputSchema: { id: z.string() } },
    async ({ id }) => {
      const j = readJob(home, id);
      if (!j) return fail(`No job "${id}".`);
      if (j.result) return text(`Already finished: ${j.result.status}`);
      try {
        process.kill(j.status.pid, 'SIGTERM');
        return text(`Stop signal sent to job ${id}.`);
      } catch (e) {
        return fail(`Could not stop pid ${j.status.pid}: ${e.message}`);
      }
    }
  );

  await server.connect(new StdioServerTransport());
}

module.exports = { start };
