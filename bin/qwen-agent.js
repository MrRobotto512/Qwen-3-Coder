#!/usr/bin/env node
// qwen-agent: run coding tasks headlessly, so another agent (Claude) can hand work to Qwen.
// See README "Headless agent" for the full picture.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadConfig, writeSampleConfig, agentHome } = require('../src/core/config');
const { loadSpecFile, parseSpec } = require('../src/core/spec');
const { runTask, readJob, listJobs, lastEvents, newJobId, jobDir, git } = require('../src/core/runner');
const { streamChat } = require('../src/core/model');

const USAGE = `qwen-agent <command>

  init                         write a sample config to ${path.join(agentHome(), 'config.json')}
  check                        test every configured model profile
  run <spec.md|spec.json>      run a task        --repo <path>  (default: current folder)
      or: run --task "text"    inline task       --gate "cmd" (repeatable)  --allow <path> (repeatable)
      options: --title <t>  --model <name>  --id <job id>  --detach  --keep-worktree  --no-web  --json
  list                         recent jobs
  status <id>                  job state and the last few events
  result <id>                  the finished result (add --json for raw)
  cancel <id>                  stop a running job
  clean                        remove leftovers of crashed jobs
  mcp                          start the MCP server (stdio) so Claude can call delegate_task

Exit code of "run": 0 when all gates pass, 1 otherwise.`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const multi = new Set(['gate', 'allow']);
  const bool = new Set(['detach', 'keep-worktree', 'no-web', 'json', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (bool.has(k)) flags[k] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        if (multi.has(k)) (flags[k] ||= []).push(v);
        else flags[k] = v;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}

function line(ev) {
  switch (ev.type) {
    case 'start': return `branch ${ev.branch} (base ${ev.base.slice(0, 8)})`;
    case 'model': return `step ${ev.step} [${ev.profile}]${ev.tools.length ? ' → ' + ev.tools.join(', ') : ' (reply)'}`;
    case 'tool': return `  ${ev.failed ? '✗' : '✓'} ${ev.name} ${ev.args.slice(0, 90).replace(/\s+/g, ' ')}`;
    case 'gates': return `gates (round ${ev.round}): ${ev.results.map((g) => `${g.name}=${g.passed ? 'pass' : 'FAIL'}`).join(' ') || 'none'}`;
    case 'fallback': return `model fallback: ${ev.from} → ${ev.to} (${(ev.error || '').slice(0, 120)})`;
    case 'compact': return `summarized ${ev.summarized} earlier messages`;
    case 'warn': return `warning: ${ev.text}`;
    case 'setup': return `setup: ${ev.command}`;
    case 'error': return `error: ${ev.error}`;
    default: return null;
  }
}

function printResult(r, asJson) {
  if (asJson) return console.log(JSON.stringify(r, null, 2));
  const out = [];
  out.push(`${r.status.toUpperCase()}  ${r.title}  (job ${r.id})`);
  if (r.error) out.push(`error: ${r.error}`);
  if (r.blocked_reason) out.push(`blocked: ${r.blocked_reason}`);
  if (r.branch) out.push(`branch: ${r.branch}${r.head ? ` @ ${r.head.slice(0, 8)}` : ''}`);
  if (r.files?.length) out.push(`files: ${r.files.map((f) => `${f.status} ${f.path} (+${f.added}/-${f.removed})`).join(', ')}`);
  for (const g of r.gates || []) out.push(`gate ${g.name}: ${g.passed ? 'pass' : `FAIL (exit ${g.exit_code})`}`);
  if (r.model) out.push(`model: ${r.model} [${r.profile}]${r.fallback_used ? ' (fallback used)' : ''}, ${r.steps} steps, ${r.fix_rounds} fix rounds, ${r.duration_s}s`);
  for (const n of r.notes || []) out.push(`note: ${n}`);
  if (r.summary) out.push('', r.summary);
  if (r.review_hint) out.push('', `review: ${r.review_hint}`);
  if (r.merge_hint) out.push(`merge:  ${r.merge_hint}`);
  console.log(out.join('\n'));
}

async function cmdRun(flags, pos) {
  const repo = path.resolve(flags.repo || process.cwd());
  let spec;
  if (flags.task) {
    spec = parseSpec(flags.task);
    spec.gates = (flags.gate || []).map((g, i) => ({ name: `gate ${i + 1}`, command: g, timeoutSec: 600 }));
    spec.allowPaths = flags.allow || [];
    if (flags.title) spec.title = flags.title;
  } else {
    if (!pos[0]) throw new Error('Give a spec file (qwen-agent run spec.md) or --task "text".');
    spec = loadSpecFile(path.resolve(pos[0]));
    if (flags.title) spec.title = flags.title;
    for (const g of flags.gate || []) spec.gates.push({ name: `gate ${spec.gates.length + 1}`, command: g, timeoutSec: 600 });
    if (flags.allow) spec.allowPaths.push(...flags.allow);
  }
  const config = loadConfig({ overrides: { model: flags.model, webResearch: flags['no-web'] ? false : undefined } });
  const id = flags.id || newJobId();

  if (flags.detach) {
    const args = [__filename, 'run', ...(flags.task ? ['--task', flags.task] : [pos[0]]), '--repo', repo, '--id', id];
    for (const k of ['model', 'title']) if (flags[k]) args.push(`--${k}`, flags[k]);
    for (const g of flags.gate || []) args.push('--gate', g);
    for (const a of flags.allow || []) args.push('--allow', a);
    if (flags['no-web']) args.push('--no-web');
    if (flags['keep-worktree']) args.push('--keep-worktree');
    fs.mkdirSync(jobDir(config.home, id), { recursive: true });
    const logFd = fs.openSync(path.join(jobDir(config.home, id), 'runner.log'), 'a');
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: process.env });
    child.unref();
    console.log(JSON.stringify({ id, status: 'starting', note: `qwen-agent status ${id}` }));
    return 0;
  }

  const ac = new AbortController();
  const stop = () => ac.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const result = await runTask({
    repo,
    spec,
    config,
    id,
    signal: ac.signal,
    keepWorktree: !!flags['keep-worktree'],
    onEvent: (ev) => {
      const l = line(ev);
      if (l && !flags.json) console.error(l);
    }
  });
  printResult(result, !!flags.json);
  return result.status === 'passed' ? 0 : 1;
}

async function cmdCheck() {
  const config = loadConfig();
  console.log(`config: ${config.source}`);
  let ok = 0;
  for (const p of config.profiles) {
    const t0 = Date.now();
    try {
      const r = await streamChat(p, { messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, { signal: AbortSignal.timeout(60_000) });
      console.log(`✓ ${p.name}: ${p.model} @ ${p.baseUrl} → "${(r.content || '').trim().slice(0, 40)}" (${Date.now() - t0} ms)`);
      ok++;
    } catch (e) {
      const keyHint = p.apiKeyEnv && !p.apiKey ? ` — environment variable ${p.apiKeyEnv} is not set` : '';
      console.log(`✗ ${p.name}: ${p.model} @ ${p.baseUrl} → ${e.message}${keyHint}`);
    }
  }
  return ok === config.profiles.length ? 0 : ok ? 0 : 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  const { flags, pos } = parseArgs(rest);
  const home = agentHome();
  switch (cmd) {
    case 'init': {
      const r = writeSampleConfig();
      console.log(r.created ? `Wrote ${r.file}. Edit it, set the API key environment variable it names, then run "qwen-agent check".` : `${r.file} already exists; left unchanged.`);
      return 0;
    }
    case 'check':
      return cmdCheck();
    case 'run':
      return cmdRun(flags, pos);
    case 'list': {
      const jobs = listJobs(home);
      if (flags.json) console.log(JSON.stringify(jobs, null, 2));
      else if (!jobs.length) console.log('No jobs yet.');
      else for (const j of jobs) console.log(`${j.id}  ${j.status.padEnd(12)} ${j.title}${j.branch ? `  [${j.branch}]` : ''}`);
      return 0;
    }
    case 'status': {
      const j = readJob(home, pos[0] || '');
      if (!j) throw new Error(`No job "${pos[0]}".`);
      console.log(JSON.stringify({ ...j.status, recent: lastEvents(home, pos[0]).map(line).filter(Boolean) }, null, 2));
      return 0;
    }
    case 'result': {
      const j = readJob(home, pos[0] || '');
      if (!j) throw new Error(`No job "${pos[0]}".`);
      if (!j.result) {
        console.log(JSON.stringify({ ...j.status, note: j.status.note || 'No result yet; the job is still running.' }, null, 2));
        return 0;
      }
      printResult(j.result, !!flags.json);
      return 0;
    }
    case 'cancel': {
      const j = readJob(home, pos[0] || '');
      if (!j) throw new Error(`No job "${pos[0]}".`);
      if (j.result) return console.log(`Job already finished (${j.result.status}).`), 0;
      try {
        process.kill(j.status.pid, 'SIGTERM');
        console.log(`Sent stop to job ${pos[0]} (pid ${j.status.pid}). On macOS/Linux it commits what it has and writes a "stopped" result; on Windows it is a hard stop, so run "qwen-agent clean" afterwards.`);
      } catch (e) {
        console.log(`Could not stop pid ${j.status.pid}: ${e.message}`);
      }
      return 0;
    }
    case 'clean': {
      let n = 0;
      for (const j of listJobs(home, { limit: 500 })) {
        const full = readJob(home, j.id);
        if (full && !full.result && full.status.status === 'crashed') {
          const work = path.join(home, 'work', j.id);
          if (fs.existsSync(work)) {
            await git(full.status.repo, ['worktree', 'remove', '--force', work], { allowFail: true });
            fs.rmSync(work, { recursive: true, force: true });
          }
          await git(full.status.repo, ['worktree', 'prune'], { allowFail: true });
          n++;
        }
      }
      console.log(`Cleaned ${n} crashed job(s).`);
      return 0;
    }
    case 'mcp':
      await require('../src/core/mcp-server').start();
      return null; // keeps running
    default:
      console.error(USAGE);
      return 2;
  }
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (err) => {
    console.error(`qwen-agent: ${err.message}`);
    process.exit(2);
  }
);
