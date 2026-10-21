// Runs one delegated task end to end: isolated git worktree on its own branch → agent →
// gates → send failures back for a fix (a few rounds) → commit → result.json.
//
// Layout under the agent home (see config.js):
//   jobs/<id>/spec.md  status.json  events.jsonl  result.json  diff.patch
//   work/<id>/         the git worktree the agent edits (removed when the job ends)
// The user's own checkout is never touched; the work lands on branch qwen/<slug>-<id>.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { AgentSession } = require('./agent');
const { runShell } = require('./tools');

const MAX_DIFF_IN_RESULT = 120_000;
const GATE_TAIL = 6_000;

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        const e = new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim().slice(0, 600)}`);
        e.code = err.code;
        return reject(e);
      }
      resolve({ code: err ? err.code ?? 1 : 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

const slug = (s) =>
  String(s || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';

function newJobId() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

function jobDir(home, id) {
  return path.join(home, 'jobs', id);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function tail(s, n) {
  return s.length > n ? `[...${s.length - n} chars omitted...]\n${s.slice(-n)}` : s;
}

function gatePrompt(failures, round, max) {
  const lines = failures.map((g) => `### Gate "${g.name}" failed (exit ${g.exit_code})\nCommand: ${g.command}\n\`\`\`\n${g.output_tail}\n\`\`\``);
  return `The automatic checks failed (fix round ${round} of ${max}).\n\n${lines.join('\n\n')}\n\nFind the cause and fix it, then run the failing command yourself to confirm before you reply. Fix the code to satisfy the spec; do not weaken, skip or delete tests to make a gate pass.`;
}

function taskPrompt(spec) {
  const parts = [`# Task: ${spec.title}`, '', spec.task];
  if (spec.gates.length) parts.push('', '## Checks', 'These run automatically when you finish; all must pass:', ...spec.gates.map((g) => `- ${g.name}: \`${g.command}\``));
  return parts.join('\n');
}

async function runGates(gates, cwd, home, id) {
  const results = [];
  for (const g of gates) {
    const r = await runShell(g.command, { cwd, timeoutMs: g.timeoutSec * 1000 });
    results.push({ name: g.name, command: g.command, passed: r.code === 0, exit_code: r.code, timed_out: r.timedOut, output_tail: tail(r.output, GATE_TAIL) });
  }
  return results;
}

// opts: { repo, spec, config (from loadConfig), id?, signal?, keepWorktree?, onEvent? }
// Returns the result object (also written to jobs/<id>/result.json).
async function runTask(opts) {
  const { spec, config } = opts;
  const repo = fs.realpathSync(path.resolve(opts.repo));
  const id = opts.id || newJobId();
  const jdir = jobDir(config.home, id);
  fs.mkdirSync(jdir, { recursive: true });
  const started = Date.now();
  const eventsFile = path.join(jdir, 'events.jsonl');
  const emit = (ev) => {
    const rec = { t: new Date().toISOString(), ...ev };
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(rec) + '\n');
    } catch {
      /* logging must never break the run */
    }
    opts.onEvent?.(rec);
  };
  const status = { id, status: 'starting', title: spec.title, repo, pid: process.pid, started: new Date(started).toISOString() };
  const setStatus = (patch) => {
    Object.assign(status, patch);
    writeJson(path.join(jdir, 'status.json'), status);
  };
  const result = { id, status: 'error', title: spec.title, repo, notes: [] };
  const finish = (patch) => {
    Object.assign(result, patch, { finished: new Date().toISOString(), duration_s: Math.round((Date.now() - started) / 1000) });
    writeJson(path.join(jdir, 'result.json'), result);
    setStatus({ status: result.status, finished: result.finished });
    return result;
  };

  fs.writeFileSync(path.join(jdir, 'spec.json'), JSON.stringify(spec, null, 2));
  setStatus({ status: 'starting' });

  let workdir = null;
  let branch = null;
  try {
    // ---- preflight ----
    const top = (await git(repo, ['rev-parse', '--show-toplevel'], { allowFail: true }));
    if (top.code !== 0) return finish({ status: 'rejected', error: `${repo} is not a git repository.` });
    const baseRef = spec.base || 'HEAD';
    const baseSha = (await git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`], { allowFail: true }));
    if (baseSha.code !== 0) return finish({ status: 'rejected', error: `Base "${baseRef}" is not a commit in ${repo}.` });
    const base = baseSha.stdout.trim();
    const dirty = (await git(repo, ['status', '--porcelain'])).stdout.trim();
    if (dirty && !spec.base) result.notes.push('The repository has uncommitted changes. The agent works from the last commit, so it cannot see them.');

    branch = `qwen/${slug(spec.title)}-${id.slice(-4)}`;
    workdir = path.join(config.home, 'work', id);
    fs.mkdirSync(path.dirname(workdir), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, workdir, base]);
    Object.assign(result, { branch, base });
    setStatus({ status: 'running', branch, base });
    emit({ type: 'start', branch, base, workdir });

    // ---- setup commands ----
    for (const cmd of spec.setup) {
      emit({ type: 'setup', command: cmd });
      const r = await runShell(cmd, { cwd: workdir, timeoutMs: 600_000 });
      if (r.code !== 0) {
        result.setup_output = tail(r.output, GATE_TAIL);
        return finish({ status: 'setup_failed', error: `Setup command failed (exit ${r.code}): ${cmd}` });
      }
    }

    // ---- agent + gates ----
    const settings = { ...config.settings };
    if (spec.webResearch !== undefined) settings.webResearch = spec.webResearch;
    const session = new AgentSession({
      root: workdir,
      profiles: config.profiles,
      settings,
      maxSteps: spec.maxSteps || config.maxSteps,
      allowPaths: spec.allowPaths,
      gates: spec.gates,
      commandTimeoutMs: config.commandTimeoutMs,
      modelRetries: config.modelRetries,
      modelBackoffMs: config.modelBackoffMs,
      signal: opts.signal,
      onEvent: emit
    });

    let turn = await session.send(taskPrompt(spec));
    let gateResults = [];
    let rounds = 0;
    let outcome;
    for (;;) {
      if (turn.status === 'blocked') {
        outcome = 'blocked';
        result.blocked_reason = turn.blocked;
        break;
      }
      if (turn.status === 'error' || turn.status === 'stopped') {
        outcome = turn.status;
        result.error = turn.error;
        break;
      }
      // done or max_steps: check the work.
      setStatus({ status: 'checking', fix_rounds: rounds });
      gateResults = await runGates(spec.gates, workdir, config.home, id);
      emit({ type: 'gates', round: rounds, results: gateResults.map((g) => ({ name: g.name, passed: g.passed, exit_code: g.exit_code })) });
      const failures = gateResults.filter((g) => !g.passed);
      if (!failures.length) {
        outcome = turn.status === 'max_steps' ? 'incomplete' : 'passed';
        if (turn.status === 'max_steps') result.notes.push('The agent hit its step limit, but all gates pass. Review the diff for completeness.');
        break;
      }
      if (rounds >= spec.maxFixRounds || turn.status === 'max_steps') {
        outcome = turn.status === 'max_steps' ? 'incomplete' : 'gates_failed';
        break;
      }
      rounds++;
      setStatus({ status: 'running', fix_rounds: rounds });
      turn = await session.send(gatePrompt(failures, rounds, spec.maxFixRounds));
    }
    if (outcome === 'incomplete' && !spec.gates.length) result.notes.push('The agent hit its step limit and there were no gates to check the work.');

    // ---- collect the work ----
    const porcelain = (await git(workdir, ['status', '--porcelain'])).stdout.trim();
    let head = base;
    if (porcelain) {
      await git(workdir, ['add', '-A']);
      const prefix = outcome === 'passed' ? '' : `WIP (${outcome}): `;
      const msg = `${prefix}${spec.title}\n\nDelegated to qwen-agent (job ${id}).${outcome === 'passed' ? '' : `\nStatus: ${outcome}. Do not merge without review.`}`;
      await git(workdir, ['-c', 'user.name=Qwen Agent', '-c', 'user.email=qwen-agent@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', msg]);
      head = (await git(workdir, ['rev-parse', 'HEAD'])).stdout.trim();
    }
    const numstat = (await git(workdir, ['diff', '--numstat', `${base}..${head}`])).stdout.trim();
    const nameStatus = (await git(workdir, ['diff', '--name-status', `${base}..${head}`])).stdout.trim();
    const statusByPath = new Map(nameStatus.split('\n').filter(Boolean).map((l) => [l.split('\t').pop(), l.split('\t')[0]]));
    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, r, p] = l.split('\t');
        return { path: p, status: statusByPath.get(p) || 'M', added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) };
      });
    const diff = (await git(workdir, ['diff', `${base}..${head}`])).stdout;
    fs.writeFileSync(path.join(jdir, 'diff.patch'), diff);

    const hasChanges = head !== base;
    if (!hasChanges && outcome === 'passed') {
      outcome = 'no_changes';
      result.notes.push('The agent finished without changing any files.');
    }
    // Nothing worth keeping: drop the empty branch so repos don't accumulate them.
    const keepBranch = hasChanges;

    return finish({
      status: outcome,
      head: hasChanges ? head : null,
      branch: keepBranch ? branch : null,
      summary: turn.message || '',
      steps: session.totalSteps,
      fix_rounds: rounds,
      compactions: session.compactions,
      tool_counts: session.toolCounts,
      model: session.profiles[session.fallbackState.index]?.model,
      profile: session.profiles[session.fallbackState.index]?.name,
      fallback_used: session.fallbackState.index > 0,
      files,
      gates: gateResults,
      diff_path: path.join(jdir, 'diff.patch'),
      diff: diff.length > MAX_DIFF_IN_RESULT ? diff.slice(0, MAX_DIFF_IN_RESULT) + `\n... [diff truncated; full patch at ${path.join(jdir, 'diff.patch')}]` : diff,
      review_hint: hasChanges ? `git -C "${repo}" diff ${base.slice(0, 8)}..${branch}` : undefined,
      merge_hint: hasChanges && outcome === 'passed' ? `git -C "${repo}" merge --no-ff ${branch}` : undefined,
      _dropBranch: !keepBranch
    });
  } catch (err) {
    emit({ type: 'error', error: err.message });
    return finish({ status: 'error', error: err.message });
  } finally {
    if (workdir && !opts.keepWorktree) {
      await git(repo, ['worktree', 'remove', '--force', workdir], { allowFail: true });
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (result._dropBranch && branch) await git(repo, ['branch', '-D', branch], { allowFail: true });
    delete result._dropBranch;
    if (fs.existsSync(path.join(jdir, 'result.json'))) writeJson(path.join(jdir, 'result.json'), result);
  }
}

// ---- reading job state back (CLI + MCP) ----
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readJob(home, id) {
  const dir = jobDir(home, id);
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  };
  let status = read('status.json');
  if (!status) {
    // A detached job has a folder before its process has written anything. Report it as
    // starting; if nothing shows up for a while the process died early (bad config, say),
    // and its log says why.
    if (!fs.existsSync(dir)) return null;
    const st = fs.statSync(dir);
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    let logTail = '';
    try {
      logTail = fs.readFileSync(path.join(dir, 'runner.log'), 'utf8').trim().slice(-800);
    } catch {
      /* no log */
    }
    const spec = read('input.json') || {};
    status = { id, status: 'starting', title: spec.title || id, started: new Date(born).toISOString() };
    if (Date.now() - born > 30_000 || /qwen-agent: /.test(logTail)) {
      status.status = 'crashed';
      status.note = `The job process stopped before it started.${logTail ? ` Log: ${logTail}` : ''}`;
    }
  }
  const result = read('result.json');
  if (!result && ['starting', 'running', 'checking'].includes(status.status) && status.pid && !pidAlive(status.pid)) {
    status.status = 'crashed';
    status.note = 'The job process is no longer running and wrote no result. Run "qwen-agent clean" to remove its leftovers.';
  }
  return { status, result, dir };
}

function listJobs(home, { limit = 20 } = {}) {
  const dir = path.join(home, 'jobs');
  let ids = [];
  try {
    ids = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'status.json')));
  } catch {
    /* none yet */
  }
  return ids
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => readJob(home, id))
    .filter(Boolean)
    .map((j) => ({ id: j.status.id, status: j.status.status, title: j.status.title, repo: j.status.repo, branch: j.status.branch, started: j.status.started, finished: j.status.finished }));
}

function lastEvents(home, id, n = 15) {
  try {
    const lines = fs.readFileSync(path.join(jobDir(home, id), 'events.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

module.exports = { runTask, readJob, listJobs, lastEvents, newJobId, jobDir, git };
