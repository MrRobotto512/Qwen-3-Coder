// The agent's tools, running against one repository folder with no UI and no human approval.
// Ported from the desktop app (renderer executeTool + main.js fs/cmd handlers), with the
// approval step replaced by hard rules: every path stays inside the repo, writes can be
// limited to allowed paths, and destructive or git-history-changing commands are refused.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const web = require('../web');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vs', '.vscode', 'target', 'bin', 'obj',
  '.cache', 'coverage', '.gradle', '.dart_tool', 'Pods', '.qwen-agent'
]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_CMD_OUTPUT = 60_000;
const MAX_TOOL_RESULT = 24_000;
const READ_PAGE = 400;
const WEB_PAGE_CHARS = 12_000;

// Same list the desktop app asks about, but here they are simply refused.
const DANGEROUS_COMMAND = /\b(rm\s+-[a-z]*[rf]|rmdir|rd\s+\/s|del\s|erase\s|format\s|mkfs|shutdown|reboot|reg\s+delete|remove-item|npm\s+publish|diskpart|bcdedit|takeown|icacls|sudo)\b/i;
// The runner owns the branch and the commit. The agent may read history, never change it.
const GIT_FORBIDDEN = /\bgit\s+(push|pull|fetch|remote|checkout|switch|branch|reset|stash|rebase|merge|commit|clean|tag|restore|cherry-pick|revert|worktree|config)\b/i;
const PIPE_TO_SHELL = /\b(curl|wget|iwr|invoke-webrequest)\b[^|\n]*\|\s*(sh|bash|zsh|pwsh|powershell|iex)\b/i;

const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'search_code', 'tool_search', 'web_search', 'fetch_url']);

const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, ...(required ? { required } : {}) } }
});

const CORE_TOOLS = [
  fn('list_files', 'List files and folders in a project folder (skips node_modules, .git and build output). Folders end with "/". Starts shallow; list a subfolder or raise depth to see more. Use this instead of run_command with dir or ls.', {
    path: { type: 'string', description: 'Folder relative to the project root. Defaults to ".".' },
    depth: { type: 'integer', description: 'How many folder levels to descend (1-6). Defaults to 2.' }
  }),
  fn('read_file', 'Read a text file from the project, optionally only a range of lines. Use this instead of run_command with type or cat. Several read_file calls in one reply run in parallel.', {
    path: { type: 'string', description: 'File path relative to the project root.' },
    start_line: { type: 'integer', description: '1-based first line (optional).' },
    end_line: { type: 'integer', description: '1-based last line, inclusive (optional).' }
  }, ['path']),
  fn('search_code', 'Search all project files for text (case-insensitive) and return matching file:line entries. Use this to find where something is defined or used instead of reading files one by one.', {
    query: { type: 'string', description: 'Text or regular expression to search for.' },
    regex: { type: 'boolean', description: 'Treat query as a regular expression.' }
  }, ['query']),
  fn('write_file', 'Create a new file, or completely overwrite an existing one. Parent folders are created automatically. For changes to an existing file, use edit_file instead.', {
    path: { type: 'string', description: 'File path relative to the project root.' },
    content: { type: 'string', description: 'The complete new file content.' }
  }, ['path', 'content']),
  fn('edit_file', 'Replace one exact snippet in an existing file. old_text must match the file exactly (including indentation) and appear exactly once; include a few surrounding lines to make it unique.', {
    path: { type: 'string', description: 'File path relative to the project root.' },
    old_text: { type: 'string', description: 'Exact existing text to replace.' },
    new_text: { type: 'string', description: 'Replacement text.' }
  }, ['path', 'old_text', 'new_text']),
  fn('web_search', 'Search the web. Use it to research SDKs, toolchains, file formats, APIs and error messages instead of relying on memory, which may be outdated. Returns titles, URLs and snippets; read the useful pages with fetch_url.', {
    query: { type: 'string', description: 'Search terms.' }
  }, ['query']),
  fn('fetch_url', 'Read a web page (or a raw file, e.g. from GitHub) as text, with links kept as [text](url). Long pages come in parts; pass offset to continue. Prefer official documentation and project repositories.', {
    url: { type: 'string' },
    offset: { type: 'integer', description: 'Character offset to continue from, as given at the end of the previous part.' }
  }, ['url']),
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Keep a short checklist for tasks with 3 or more steps, instead of listing the steps in your reply. Send the whole list every time. Mark one item in_progress while you work on it and mark items completed as soon as they are done. Skip it for simple one-step requests.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string', description: 'What needs to be done, in a few words.' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  fn('run_command', 'Run a shell command in the project root and return its output (non-interactive, 2 minute timeout). Use it to build, test, install packages or run scripts, instead of for reading or searching files. Destructive commands and git commands that change history or branches are refused.', {
    command: { type: 'string', description: 'The command line to run.' }
  }, ['command']),
  fn('report_blocked', 'Call this instead of guessing when the task cannot be completed as specified: the spec is contradictory, something it depends on is missing, or you need a decision only the requester can make. This ends the run and sends your reason back to the requester.', {
    reason: { type: 'string', description: 'What is blocking, what you tried, and what you need.' }
  }, ['reason'])
];

const DEFERRED_TOOLS = [
  fn('delete_file', 'Delete a text file from the project.', { path: { type: 'string', description: 'File path relative to the project root.' } }, ['path']),
  fn('move_file', 'Move or rename a text file inside the project, instead of writing a copy and deleting the original.', {
    from: { type: 'string', description: 'Current path.' },
    to: { type: 'string', description: 'New path; must not exist yet.' }
  }, ['from', 'to'])
];

const TOOL_SEARCH_TOOL = fn('tool_search', 'Load tools listed in <deferred_tools> so you can call them. Search by name or purpose.', { query: { type: 'string', description: 'What you need to do, or a tool name.' } }, ['query']);

function truncate(s) {
  return s.length > MAX_TOOL_RESULT ? s.slice(0, MAX_TOOL_RESULT) + `\n... [truncated ${s.length - MAX_TOOL_RESULT} chars]` : s;
}

function normPath(root, p) {
  let s = String(p || '').replace(/\\/g, '/').trim();
  const r = root.replace(/\\/g, '/');
  if (s.toLowerCase().startsWith(r.toLowerCase() + '/')) s = s.slice(r.length + 1);
  return s.replace(/^\.\//, '').replace(/^\/+/, '') || '.';
}

// Environment for child processes: keep the machine's PATH and friends, drop anything that
// looks like a credential so a spec'd command (or a model-written one) can't read the API key.
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(k) || /^QWEN_AGENT_/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// Runs a shell command in `cwd`. Used by run_command and by the runner's gates.
function runShell(command, { cwd, timeoutMs = 120_000, env = childEnv() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env, detached: process.platform !== 'win32' });
    let output = '';
    let timedOut = false;
    const append = (d) => {
      output += d.toString();
      if (output.length > MAX_CMD_OUTPUT * 2) output = output.slice(-MAX_CMD_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      append(`\n[timed out after ${timeoutMs / 1000}s — process killed]\n`);
      killTree(child);
    }, timeoutMs);
    child.on('error', (err) => append(`\n[error] ${err.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (output.length > MAX_CMD_OUTPUT) output = '[...output truncated...]\n' + output.slice(-MAX_CMD_OUTPUT);
      resolve({ code: timedOut ? 124 : code, output, timedOut });
    });
  });
}

async function isProbablyBinary(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, 8000, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

// settings: { webResearch, searchProvider, searchApiKey, searxngUrl, allowPrivateFetch }
// options:  { allowPaths: ['src/', 'test/x.js'] (writes only; empty = anywhere in the repo),
//             denyPaths: extra write-protected prefixes, commandTimeoutMs }
function createToolbox(rootDir, settings = {}, options = {}) {
  const root = fs.realpathSync(path.resolve(rootDir));
  const allowPaths = (options.allowPaths || []).map((p) => normPath(root, p).replace(/\/+$/, ''));
  const denyPaths = ['.git', '.qwen-agent', ...(options.denyPaths || []).map((p) => normPath(root, p).replace(/\/+$/, ''))];
  const commandTimeoutMs = options.commandTimeoutMs || 120_000;
  const state = { todos: [], active: new Set(), changed: new Map(), blocked: null };
  const webOn = settings.webResearch !== false;

  function resolve(p) {
    const abs = path.resolve(root, p || '.');
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path is outside the project: ${p}`);
    // Follow symlinks on the nearest existing ancestor so a link can't lead out of the repo.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const back = path.relative(root, real);
    if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`Path leaves the project through a link: ${p}`);
    return abs;
  }
  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/') || '.';
  const under = (rel, prefix) => rel === prefix || rel.startsWith(prefix + '/');

  function checkWritable(rel) {
    if (rel === '.') throw new Error('Refusing to modify the project root.');
    for (const d of denyPaths) if (under(rel, d)) throw new Error(`${rel} is protected; the agent may not change it.`);
    if (allowPaths.length && !allowPaths.some((a) => under(rel, a))) {
      throw new Error(`${rel} is outside the paths this task may change (${allowPaths.join(', ')}). If the task really needs it, call report_blocked.`);
    }
  }

  function noteChange(rel, before, after) {
    const prev = state.changed.get(rel);
    state.changed.set(rel, { created: prev ? prev.created : before === null, deleted: after === null });
  }

  async function walk(dir, out, limit, maxDepth, depth = 0) {
    if (out.length >= limit || depth >= maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        out.push(toRel(abs) + '/');
        await walk(abs, out, limit, maxDepth, depth + 1);
      } else if (e.isFile()) out.push(toRel(abs));
    }
  }

  async function readText(rel) {
    const abs = resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
    if (st.size > MAX_READ_BYTES) throw new Error(`File is too large to open (${Math.round(st.size / 1024)} KB): ${rel}`);
    if (await isProbablyBinary(abs)) throw new Error(`File looks binary: ${rel}`);
    return fsp.readFile(abs, 'utf8');
  }

  async function writeText(rel, content) {
    const abs = resolve(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }

  const exists = async (rel) => {
    try {
      await fsp.access(resolve(rel));
      return true;
    } catch {
      return false;
    }
  };

  const lineStats = (before, after) => {
    const a = (before ?? '').split('\n');
    const b = after.split('\n');
    const set = new Set(a);
    const setB = new Set(b);
    return { added: b.filter((l) => !set.has(l)).length, removed: a.filter((l) => !setB.has(l)).length };
  };

  function deferredCatalog() {
    return DEFERRED_TOOLS;
  }

  function specs() {
    const core = webOn ? CORE_TOOLS : CORE_TOOLS.filter((t) => !['web_search', 'fetch_url'].includes(t.function.name));
    const tools = [...core, ...DEFERRED_TOOLS.filter((t) => state.active.has(t.function.name))];
    if (DEFERRED_TOOLS.some((t) => !state.active.has(t.function.name))) tools.push(TOOL_SEARCH_TOOL);
    return tools;
  }

  function allNames() {
    return [...CORE_TOOLS, ...DEFERRED_TOOLS, TOOL_SEARCH_TOOL].map((t) => t.function.name);
  }

  // Returns { result, failed?, rejected? }. Never throws.
  async function execute(call) {
    const name = call.function.name;
    let args;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return { result: `Error: arguments were not valid JSON: ${call.function.arguments.slice(0, 300)}`, failed: true };
    }
    try {
      switch (name) {
        case 'list_files': {
          const depth = Math.min(6, Math.max(1, parseInt(args.depth, 10) || 2));
          const out = [];
          await walk(resolve(normPath(root, args.path || '.')), out, 200, depth);
          return { result: (out.join('\n') || '(empty)') + (out.length >= 200 ? '\n... (truncated at 200 entries — list a subfolder for more)' : '') };
        }
        case 'read_file': {
          const p = normPath(root, args.path);
          const text0 = await readText(p);
          const all = text0.split(/\r?\n/);
          const lineCount = all.length - (all[all.length - 1] === '' ? 1 : 0);
          const start = Math.max(1, parseInt(args.start_line, 10) || 1);
          const end = Math.min(lineCount, parseInt(args.end_line, 10) || start + READ_PAGE - 1, start + READ_PAGE * 2 - 1);
          const paged = start > 1 || end < lineCount;
          const text = paged ? all.slice(start - 1, end).join('\n') : text0;
          const header = `${p} (${lineCount} lines)${paged ? `, showing lines ${start}-${end}` : ''}`;
          const more = end < lineCount ? `\n[${lineCount - end} more lines. Call read_file with start_line=${end + 1} to continue.]` : '';
          return { result: `${header}:\n${truncate(text)}${more}` };
        }
        case 'search_code': {
          const query = String(args.query || '');
          if (!query) return { result: 'Error: empty query.', failed: true };
          let re = null;
          try {
            re = args.regex ? new RegExp(query, 'i') : null;
          } catch (err) {
            return { result: `Error: invalid regex: ${err.message}`, failed: true };
          }
          const files = [];
          await walk(root, files, 5000, 12);
          const needle = query.toLowerCase();
          const hits = [];
          for (const f of files) {
            if (f.endsWith('/')) continue;
            try {
              const abs = path.join(root, f);
              const st = await fsp.stat(abs);
              if (st.size > 1024 * 1024 || (await isProbablyBinary(abs))) continue;
              const lines = (await fsp.readFile(abs, 'utf8')).split(/\r?\n/);
              for (let i = 0; i < lines.length && hits.length < 80; i++) {
                if (re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle)) hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              }
            } catch {
              /* unreadable file, skip */
            }
            if (hits.length >= 80) break;
          }
          const out = hits.length ? hits.join('\n') : 'No matches.';
          return { result: hits.length >= 80 ? `${out}\n[Showing the first 80 matches. Narrow the query to see others.]` : out };
        }
        case 'write_file': {
          const p = normPath(root, args.path);
          checkWritable(p);
          const content = String(args.content ?? '');
          const had = await exists(p);
          const original = had ? await readText(p) : null;
          if (had && original === content) return { result: 'File already has exactly this content; nothing changed.' };
          await writeText(p, content);
          noteChange(p, original, content);
          const st = lineStats(original, content);
          return { result: `${had ? 'Edited' : 'Created'} ${p} (${content.split('\n').length} lines, +${st.added} −${st.removed}).`, progress: true };
        }
        case 'edit_file': {
          const p = normPath(root, args.path);
          checkWritable(p);
          const original = await readText(p);
          let oldText = String(args.old_text ?? '');
          let newText = String(args.new_text ?? '');
          if (!oldText) return { result: 'Error: old_text is empty. Use write_file to create or overwrite a file.', failed: true };
          if (!original.includes(oldText) && original.includes('\r\n')) {
            oldText = oldText.replace(/\r?\n/g, '\r\n');
            newText = newText.replace(/\r?\n/g, '\r\n');
          }
          const count = original.split(oldText).length - 1;
          if (count === 0) return { result: `Error: old_text was not found in ${p}. Read the file again and copy the exact text, including whitespace.`, failed: true };
          if (count > 1) return { result: `Error: old_text matches ${count} places in ${p}. Include more surrounding lines so it is unique.`, failed: true };
          const modified = original.replace(oldText, () => newText);
          await writeText(p, modified);
          noteChange(p, original, modified);
          const st = lineStats(original, modified);
          return { result: `Edited ${p} (${modified.split('\n').length} lines, +${st.added} −${st.removed}).`, progress: true };
        }
        case 'delete_file': {
          const p = normPath(root, args.path);
          checkWritable(p);
          let original;
          try {
            original = await readText(p);
          } catch (e) {
            return { result: `Error: ${e.message}. delete_file only removes single text files.`, failed: true };
          }
          await fsp.rm(resolve(p), { force: true });
          noteChange(p, original, null);
          return { result: `Deleted ${p}.`, progress: true };
        }
        case 'move_file': {
          const from = normPath(root, args.from);
          const to = normPath(root, args.to);
          if (from === to || to === '.') return { result: 'Error: give a different destination path.', failed: true };
          checkWritable(from);
          checkWritable(to);
          let content;
          try {
            content = await readText(from);
          } catch (e) {
            return { result: `Error: ${e.message}. move_file only moves single text files.`, failed: true };
          }
          if (await exists(to)) return { result: `Error: ${to} already exists. Pick another name, or delete it first.`, failed: true };
          await writeText(to, content);
          await fsp.rm(resolve(from), { force: true });
          noteChange(to, null, content);
          noteChange(from, content, null);
          return { result: `Moved ${from} to ${to}.`, progress: true };
        }
        case 'tool_search': {
          const words = String(args.query || '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
          const matches = deferredCatalog().filter((t) => !words.length || words.some((w) => `${t.function.name} ${t.function.description}`.toLowerCase().includes(w)));
          if (!matches.length) return { result: `No matching tools. Deferred tools: ${deferredCatalog().map((t) => t.function.name).join(', ')}.` };
          for (const t of matches) state.active.add(t.function.name);
          return { result: `Loaded ${matches.map((t) => t.function.name).join(', ')}. You can call ${matches.length === 1 ? 'it' : 'them'} from your next reply.\n\n${matches.map((t) => `${t.function.name}: ${t.function.description}\nParameters: ${JSON.stringify(t.function.parameters.properties)}`).join('\n\n')}` };
        }
        case 'web_search': {
          if (!webOn) return { result: 'Error: web research is turned off for this task.', failed: true };
          const q = String(args.query || '').trim();
          if (!q) return { result: 'Error: empty search query.', failed: true };
          const results = await web.webSearch(settings, q);
          const out = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
          return { result: results.length ? `<web_results query="${q.replace(/"/g, "'")}">\n${out}\n</web_results>\nRead the most relevant pages (official docs and repositories first) with fetch_url.` : 'No results. Try different search terms.' };
        }
        case 'fetch_url': {
          if (!webOn) return { result: 'Error: web research is turned off for this task.', failed: true };
          const page = await web.fetchPage(settings, String(args.url || ''));
          const offset = Math.max(0, parseInt(args.offset, 10) || 0);
          const part = page.text.slice(offset, offset + WEB_PAGE_CHARS);
          const left = page.text.length - offset - part.length;
          const more = left > 0 ? `\n[${left.toLocaleString()} more characters. Call fetch_url with offset=${offset + part.length} to continue.]` : '';
          return { result: `<web_page url="${page.url}" title="${(page.title || '').replace(/"/g, "'")}">\n${part || '(no readable text)'}\n</web_page>${more}${page.truncated ? '\n[The page was too large and was cut off.]' : ''}` };
        }
        case 'todo_write': {
          const todos = (Array.isArray(args.todos) ? args.todos : [])
            .slice(0, 20)
            .map((t) => ({ content: String(t.content || '').slice(0, 200), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }))
            .filter((t) => t.content);
          state.todos = todos;
          const done = todos.filter((t) => t.status === 'completed').length;
          const current = todos.find((t) => t.status === 'in_progress');
          return { result: `Plan updated: ${done}/${todos.length} done.${current ? ` In progress: ${current.content}.` : ''}` };
        }
        case 'run_command': {
          const cmd = String(args.command || '').trim();
          if (!cmd) return { result: 'Error: empty command.', failed: true };
          if (DANGEROUS_COMMAND.test(cmd) || GIT_FORBIDDEN.test(cmd) || PIPE_TO_SHELL.test(cmd)) {
            return {
              result: 'Refused: this command is destructive, changes git history/branches, or pipes a download into a shell. The runner manages branches and commits. Find another way, or call report_blocked if it is truly required.',
              failed: true,
              rejected: true
            };
          }
          const r = await runShell(cmd, { cwd: root, timeoutMs: commandTimeoutMs });
          return { result: `Exit code: ${r.code}\n${truncate(r.output || '(no output)')}`, failed: r.code !== 0, progress: r.code === 0 };
        }
        case 'report_blocked': {
          const reason = String(args.reason || '').trim() || '(no reason given)';
          state.blocked = reason;
          return { result: 'Recorded. The requester will be told.', blocked: true };
        }
        default:
          return { result: `Error: unknown tool "${name}". Available tools: ${specs().map((t) => t.function.name).join(', ')}.`, failed: true };
      }
    } catch (e) {
      return { result: `Error: ${e.message}`, failed: true };
    }
  }

  return { root, specs, execute, allNames, state, normPath: (p) => normPath(root, p), checkWritable };
}

module.exports = { createToolbox, runShell, childEnv, READ_ONLY_TOOLS, truncate, DANGEROUS_COMMAND, GIT_FORBIDDEN };
