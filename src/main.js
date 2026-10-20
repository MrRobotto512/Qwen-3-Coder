const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const updater = require('./updater');
const { detectSpecs } = require('./hardware');
const web = require('./web');
const mcp = require('./mcp');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vs', '.vscode', 'target', 'bin', 'obj',
  '.cache', 'coverage', '.gradle', '.dart_tool', 'Pods'
]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_CMD_OUTPUT = 60_000;

const DEFAULT_SETTINGS = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'qwen2.5-coder:7b',
  temperature: 0.2,
  agentMode: true,
  // 'ask': approve every edit and command; 'edits': edits apply automatically, commands ask
  // (unless allow-listed); 'auto': nothing asks except destructive commands.
  approvalMode: 'edits',
  allowedCommands: [],
  includeCurrentFile: true,
  followAgent: true,
  contextLength: 32768,
  recentWorkspaces: [],
  autoCheckUpdates: true,
  webResearch: true, // lets the agent use web_search and fetch_url
  searchProvider: 'duckduckgo', // duckduckgo | brave | searxng
  searchApiKey: '',
  searxngUrl: '',
  allowPrivateFetch: false,
  mcpServers: [], // [{ name, command, args, env, url, type, cwd, enabled }]
  lastConversations: {}, // workspace root -> id of the conversation open when the app closed
  lastWorkspace: null,
  fontSize: 14
};

let mainWindow;
let workspaceRoot = null;
const chatControllers = new Map();

// ---------- settings ----------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    // Migrate the old on/off approval checkboxes.
    if (!saved.approvalMode && saved.autoApproveCommands) saved.approvalMode = 'auto';
    delete saved.autoApproveEdits;
    delete saved.autoApproveCommands;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

// ---------- path safety ----------
// Every file operation is confined to the open workspace folder.
function resolveInWorkspace(p) {
  if (!workspaceRoot) throw new Error('No workspace folder is open.');
  const abs = path.resolve(workspaceRoot, p || '.');
  const rel = path.relative(workspaceRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${p}`);
  }
  return abs;
}
function toRel(abs) {
  return path.relative(workspaceRoot, abs).split(path.sep).join('/') || '.';
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

async function walk(dir, out, limit, maxDepth = 12, depth = 0) {
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
    } else if (e.isFile()) {
      out.push(toRel(abs));
    }
  }
}

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121215',
    title: 'Qwen Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  // The renderer cancels unload when there are unsaved tabs; ask before discarding them.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close Qwen Workspace and discard them?'
    });
    if (choice === 0) e.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });
}

app.whenReady().then(() => {
  createWindow();
  mcp.setOnChange(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('mcp:changed', mcp.describe()));
  mcp.connectAll(loadSettings().mcpServers).catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: settings ----------
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch };
  saveSettings(s);
  return s;
});

// ---------- IPC: workspace ----------
ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});
ipcMain.handle('workspace:set', async (_e, dir) => {
  if (!dir) return null;
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  workspaceRoot = path.resolve(dir);
  const s = loadSettings();
  s.lastWorkspace = workspaceRoot;
  s.recentWorkspaces = [workspaceRoot, ...(s.recentWorkspaces || []).filter((p) => p !== workspaceRoot)].slice(0, 8);
  saveSettings(s);
  mainWindow.setTitle(`${path.basename(workspaceRoot)} — Qwen Workspace`);
  return { root: workspaceRoot, name: path.basename(workspaceRoot), sep: path.sep, platform: process.platform };
});

// ---------- IPC: filesystem ----------
ipcMain.handle('fs:list', async (_e, rel) => {
  const abs = resolveInWorkspace(rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isFile())
    .filter((e) => !(e.isDirectory() && (e.name === '.git' || e.name === 'node_modules')))
    .map((e) => ({ name: e.name, path: toRel(path.join(abs, e.name)), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});

ipcMain.handle('fs:listRecursive', async (_e, rel, limit = 500, maxDepth = 12) => {
  const abs = resolveInWorkspace(rel);
  const out = [];
  await walk(abs, out, limit, maxDepth);
  return { files: out, truncated: out.length >= limit };
});

ipcMain.handle('fs:read', async (_e, rel) => {
  const abs = resolveInWorkspace(rel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`File is too large to open (${Math.round(st.size / 1024)} KB): ${rel}`);
  if (await isProbablyBinary(abs)) throw new Error(`File looks binary: ${rel}`);
  return fsp.readFile(abs, 'utf8');
});

ipcMain.handle('fs:exists', async (_e, rel) => {
  try {
    await fsp.access(resolveInWorkspace(rel));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:write', async (_e, rel, content) => {
  const abs = resolveInWorkspace(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return true;
});

ipcMain.handle('fs:mkdir', async (_e, rel) => {
  await fsp.mkdir(resolveInWorkspace(rel), { recursive: true });
  return true;
});

// `quiet` skips the confirmation; the renderer uses it only when reverting a file Qwen created,
// after the user has already confirmed the revert.
ipcMain.handle('fs:delete', async (_e, rel, opts = {}) => {
  const abs = resolveInWorkspace(rel);
  if (abs === workspaceRoot) throw new Error('Refusing to delete the workspace root.');
  if (!opts.quiet) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete "${rel}"?`,
      detail: 'This cannot be undone.'
    });
    if (response !== 0) return false;
  }
  await fsp.rm(abs, { recursive: true, force: true });
  return true;
});

ipcMain.handle('fs:search', async (_e, query, opts = {}) => {
  if (!query) return [];
  const files = [];
  await walk(resolveInWorkspace('.'), files, 5000);
  let re;
  try {
    re = opts.regex ? new RegExp(query, 'i') : null;
  } catch (err) {
    throw new Error(`Invalid regex: ${err.message}`);
  }
  const needle = query.toLowerCase();
  const results = [];
  for (const f of files) {
    if (f.endsWith('/')) continue;
    const abs = path.join(workspaceRoot, f);
    try {
      const st = await fsp.stat(abs);
      if (st.size > 1024 * 1024 || (await isProbablyBinary(abs))) continue;
      const lines = (await fsp.readFile(abs, 'utf8')).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
        if (hit) {
          results.push({ path: f, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= (opts.limit || 100)) return results;
        }
      }
    } catch {
      /* unreadable file, skip */
    }
  }
  return results;
});

ipcMain.handle('shell:reveal', (_e, rel) => shell.showItemInFolder(resolveInWorkspace(rel)));

// ---------- IPC: commands ----------
ipcMain.handle('cmd:run', (_e, command, timeoutMs = 120_000) => {
  const cwd = resolveInWorkspace('.');
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    let output = '';
    const append = (d) => {
      output += d.toString();
      mainWindow?.webContents.send('cmd:output', d.toString());
      if (output.length > MAX_CMD_OUTPUT * 2) output = output.slice(-MAX_CMD_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      append(`\n[timed out after ${timeoutMs / 1000}s — process killed]\n`);
      killTree(child);
    }, timeoutMs);
    child.on('error', (err) => append(`\n[error] ${err.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (output.length > MAX_CMD_OUTPUT) output = '[...output truncated...]\n' + output.slice(-MAX_CMD_OUTPUT);
      resolve({ code, output });
    });
  });
});

function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

// ---------- IPC: model ----------
function apiHeaders(s) {
  const h = { 'Content-Type': 'application/json' };
  if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
  return h;
}
function apiUrl(s, suffix) {
  return s.baseUrl.trim().replace(/\/+$/, '') + suffix;
}

ipcMain.handle('model:list', async () => {
  const s = loadSettings();
  const res = await fetch(apiUrl(s, '/models'), { headers: apiHeaders(s), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
});

ipcMain.handle('chat:abort', (_e, id) => {
  chatControllers.get(id)?.abort();
  return true;
});

// Streams one completion. Deltas are pushed to the renderer as they arrive;
// the resolved value is the full assistant turn (text + any tool calls).
ipcMain.handle('chat:stream', async (event, id, payload) => {
  const s = loadSettings();
  const controller = new AbortController();
  chatControllers.set(id, controller);
  const send = (type, data) => {
    if (!event.sender.isDestroyed()) event.sender.send('chat:event', { id, type, data });
  };

  if (await isOllama(s)) {
    try {
      return await streamOllama(s, payload, controller.signal, send);
    } catch (err) {
      return chatError(err, s);
    } finally {
      chatControllers.delete(id);
    }
  }

  const body = {
    model: s.model,
    messages: payload.messages,
    stream: true,
    temperature: Number(s.temperature)
  };
  if (payload.tools?.length) body.tools = payload.tools;

  try {
    const res = await fetch(apiUrl(s, '/chat/completions'), {
      method: 'POST',
      headers: apiHeaders(s),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} from ${s.baseUrl}: ${text.slice(0, 600)}`);
    }

    let content = '';
    let reasoning = '';
    const toolCalls = [];
    let finishReason = null;
    const decoder = new TextDecoder();
    let buffer = '';

    const handleChunk = (json) => {
      const choice = json.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || choice.message || {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) {
        reasoning += r;
        send('reasoning', r);
      }
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        send('delta', d.content);
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          let i = tc.index;
          if (i === undefined) {
            const found = tc.id ? toolCalls.findIndex((t) => t.id === tc.id) : -1;
            i = found >= 0 ? found : tc.id || toolCalls.length === 0 ? toolCalls.length : toolCalls.length - 1;
          }
          const slot = (toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name && !slot.function.name) slot.function.name = tc.function.name;
          const args = tc.function?.arguments;
          if (args !== undefined && args !== null) {
            slot.function.arguments += typeof args === 'string' ? args : JSON.stringify(args);
          }
          send('tool_progress', toolCalls.filter(Boolean).map((t) => t.function.name));
        }
      }
    };

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          handleChunk(JSON.parse(data));
        } catch {
          /* ignore malformed keep-alive lines */
        }
      }
    }

    const calls = toolCalls.filter(Boolean).map((t, i) => ({ ...t, id: t.id || `call_${Date.now()}_${i}` }));
    return { ok: true, content, reasoning, toolCalls: calls, finishReason };
  } catch (err) {
    return chatError(err, s);
  } finally {
    chatControllers.delete(id);
  }
});

function chatError(err, s) {
  if (err.name === 'AbortError') return { ok: true, aborted: true };
  let msg = err.message;
  if (err.cause?.code === 'ECONNREFUSED') {
    msg = `Could not connect to ${s.baseUrl}. Is Ollama / LM Studio running? (${err.cause.code})`;
  }
  return { ok: false, error: msg };
}

// ---------- Ollama native API ----------
// Ollama's OpenAI-compatible endpoint ignores the context size and silently drops the
// oldest messages (including the system prompt) once a chat outgrows its small default.
// The native /api/chat endpoint lets us set num_ctx, so we use it whenever we talk to Ollama.
const ollamaCache = new Map();

function ollamaRoot(s) {
  return s.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

// Only Ollama answers GET /api/version with {"version": ...}; check once per server URL.
async function isOllama(s) {
  const root = ollamaRoot(s);
  if (!ollamaCache.has(root)) {
    let yes = false;
    try {
      const r = await fetch(`${root}/api/version`, { signal: AbortSignal.timeout(3000) });
      yes = r.ok && typeof (await r.json()).version === 'string';
    } catch {
      /* not Ollama, or not reachable */
    }
    ollamaCache.set(root, yes);
  }
  return ollamaCache.get(root);
}

function toOllamaMessages(messages) {
  const toolNames = new Map();
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        toolNames.set(tc.id, tc.function.name);
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* keep empty */
        }
        return { function: { name: tc.function.name, arguments: args } };
      });
    }
    if (m.role === 'tool' && toolNames.has(m.tool_call_id)) out.tool_name = toolNames.get(m.tool_call_id);
    return out;
  });
}

async function streamOllama(s, payload, signal, send) {
  const root = ollamaRoot(s);
  const contextLength = Number(s.contextLength) || DEFAULT_SETTINGS.contextLength;
  const body = {
    model: s.model,
    messages: toOllamaMessages(payload.messages),
    stream: true,
    options: { temperature: Number(s.temperature), num_ctx: contextLength }
  };
  if (payload.tools?.length) body.tools = payload.tools;

  const res = await fetch(`${root}/api/chat`, {
    method: 'POST',
    headers: apiHeaders(s),
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${root}: ${text.slice(0, 600)}`);
  }

  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let finishReason = null;
  let promptTokens = 0;
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (j) => {
    if (j.error) throw new Error(j.error);
    const m = j.message || {};
    if (m.thinking) {
      reasoning += m.thinking;
      send('reasoning', m.thinking);
    }
    if (m.content) {
      content += m.content;
      send('delta', m.content);
    }
    for (const tc of m.tool_calls || []) {
      const args = tc.function?.arguments;
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: { name: tc.function?.name || '', arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) }
      });
      send('tool_progress', toolCalls.map((t) => t.function.name));
    }
    if (j.done) {
      finishReason = j.done_reason || 'stop';
      promptTokens = j.prompt_eval_count || 0;
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handle(JSON.parse(line));
    }
  }
  if (buffer.trim()) handle(JSON.parse(buffer));

  return { ok: true, content, reasoning, toolCalls, finishReason, usage: { promptTokens, contextLength } };
}

// ---------- app info & updates ----------
ipcMain.handle('app:info', () => ({ version: app.getVersion(), kind: updater.installKind(), releasesUrl: updater.RELEASES_URL }));
ipcMain.handle('update:check', () => updater.checkForUpdate());
ipcMain.handle('update:download', (event) =>
  updater.downloadUpdate((p) => {
    if (!event.sender.isDestroyed()) event.sender.send('update:progress', p);
  })
);
ipcMain.handle('update:install', () => updater.installUpdate());
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- hardware & local models ----------
ipcMain.handle('system:specs', (_e, force) => detectSpecs(force));

// Ollama's own address: the configured server when it is Ollama, otherwise the default local one.
async function ollamaBase() {
  const s = loadSettings();
  if (s.provider === 'ollama' || (await isOllama(s))) return ollamaRoot(s);
  return 'http://localhost:11434';
}

ipcMain.handle('ollama:tags', async () => {
  const base = await ollamaBase();
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { running: false, base, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { running: true, base, models: (json.models || []).map((m) => ({ name: m.name, size: m.size, params: m.details?.parameter_size, quant: m.details?.quantization_level })) };
  } catch (err) {
    return { running: false, base, error: err.cause?.code || err.message };
  }
});

const pulls = new Map();

ipcMain.handle('ollama:pull', async (event, model) => {
  const base = await ollamaBase();
  const controller = new AbortController();
  pulls.set(model, controller);
  const send = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('ollama:pull-progress', { model, ...data });
  };
  try {
    const res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, name: model, stream: true }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSent = 0;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        // Progress lines arrive very fast; pass on a few per second.
        const now = Date.now();
        if (j.status !== 'downloading' || !j.total || now - lastSent > 250 || j.completed === j.total) {
          lastSent = now;
          send({ status: j.status, completed: j.completed, total: j.total });
        }
      }
    }
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, cancelled: true };
    return { ok: false, error: err.cause?.code === 'ECONNREFUSED' ? `Ollama isn't running at ${base}.` : err.message };
  } finally {
    pulls.delete(model);
  }
});

ipcMain.handle('ollama:pull-cancel', (_e, model) => {
  pulls.get(model)?.abort();
  return true;
});

// ---------- conversation history ----------
// Each conversation is a JSON file; index.json holds the summaries the history list shows.
const CONV_ID = /^[a-z0-9]{6,40}$/i;

function convDir() {
  return path.join(app.getPath('userData'), 'conversations');
}
function convFile(id) {
  if (!CONV_ID.test(String(id))) throw new Error('Invalid conversation id');
  return path.join(convDir(), `${id}.json`);
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function readConvIndex() {
  try {
    return JSON.parse(fs.readFileSync(path.join(convDir(), 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}
function convSummary(c) {
  return {
    id: c.id,
    title: c.title,
    workspace: c.workspace,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    status: c.status,
    model: c.model,
    mode: c.mode,
    changes: (c.changes || []).length,
    messages: (c.display || []).filter((d) => d.t === 'user').length
  };
}
function updateConvIndex(fn) {
  const index = fn(readConvIndex());
  writeJsonAtomic(path.join(convDir(), 'index.json'), index);
  return index;
}

ipcMain.handle('conv:list', (_e, workspace) =>
  readConvIndex()
    .filter((c) => !workspace || c.workspace === workspace)
    .sort((a, b) => b.updatedAt - a.updatedAt)
);
ipcMain.handle('conv:load', (_e, id) => JSON.parse(fs.readFileSync(convFile(id), 'utf8')));
ipcMain.handle('conv:save', (_e, conv) => {
  writeJsonAtomic(convFile(conv.id), conv);
  const summary = convSummary(conv);
  updateConvIndex((index) => [...index.filter((c) => c.id !== conv.id), summary]);
  return summary;
});
ipcMain.handle('conv:delete', (_e, id) => {
  fs.rmSync(convFile(id), { force: true });
  updateConvIndex((index) => index.filter((c) => c.id !== id));
  return true;
});

// ---------- long context (YaRN) ----------
// What a downloaded model was trained for, and whether its GGUF carries YaRN rope scaling.
ipcMain.handle('ollama:show', async (_e, model) => {
  const base = await ollamaBase();
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, name: model }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const info = (await res.json()).model_info || {};
    const arch = info['general.architecture'];
    const key = (k) => info[`${arch}.${k}`] ?? null;
    return {
      arch,
      contextLength: key('context_length'),
      rope: { type: key('rope.scaling.type'), factor: key('rope.scaling.factor'), originalContext: key('rope.scaling.original_context_length') }
    };
  } catch {
    return null;
  }
});

// Finds the 4-bit GGUF in a Hugging Face repo and the name Ollama pulls it by
// (hf.co/<repo>:<quant>). Unsharded files only; Ollama can't pull split GGUFs from hf.co.
const hfCache = new Map();
const QUANT_PREFERENCE = [/^Q4_K_M$/i, /^UD-Q4_K_XL$/i, /^Q4_K_S$/i, /^Q4_0$/i, /^Q5_K_M$/i, /^Q3_K_M$/i];

ipcMain.handle('hf:resolve', async (_e, repo) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error('Invalid repository name');
  if (hfCache.has(repo)) return hfCache.get(repo);
  let result;
  try {
    // HF_ENDPOINT is the standard way to point Hugging Face tools at a mirror.
    const endpoint = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
    const res = await fetch(`${endpoint}/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 404 || res.status === 401) {
      result = { status: 'missing', repo };
    } else if (!res.ok) {
      throw new Error(`Hugging Face returned HTTP ${res.status}`);
    } else {
      const files = ((await res.json()).siblings || [])
        .map((s) => ({ name: s.rfilename, size: s.size || 0, quant: /((?:UD-)?(?:I?Q\d\w*|BF16|F16|F32))\.gguf$/i.exec(s.rfilename)?.[1] }))
        .filter((f) => f.quant && !f.name.includes('/') && !/mmproj/i.test(f.name) && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.name));
      let file = null;
      for (const pref of QUANT_PREFERENCE) if ((file = files.find((f) => pref.test(f.quant)))) break;
      result = file
        ? { status: 'ok', repo, file: file.name, tag: file.quant, sizeGB: file.size / 1e9, ollamaId: `hf.co/${repo}:${file.quant}` }
        : { status: 'missing', repo };
    }
    hfCache.set(repo, result);
  } catch (err) {
    // Not cached, so it is retried next time.
    result = { status: 'error', repo, error: err.cause?.code || err.message };
  }
  return result;
});

// ---------- skills ----------
// A skill is a folder with SKILL.md (optional front matter: name, description) plus any
// supporting files. Project skills live in <project>/.qwen/skills, personal ones in the app's
// data folder. Only names and descriptions go into the prompt; the rest loads on demand.
function skillRoots() {
  const roots = [];
  if (workspaceRoot) roots.push(['project', path.join(workspaceRoot, '.qwen', 'skills')]);
  roots.push(['user', path.join(app.getPath('userData'), 'skills')]);
  return roots;
}

function parseSkill(text, dirName) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
  return { name: meta.name || dirName, description: (meta.description || firstLine).slice(0, 300), body };
}

ipcMain.handle('skills:list', async () => {
  const byName = new Map();
  // User skills first so a project skill with the same name replaces it.
  for (const [scope, root] of skillRoots().reverse()) {
    let dirs = [];
    try {
      dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      try {
        const text = await fsp.readFile(path.join(root, d.name, 'SKILL.md'), 'utf8');
        const { name, description } = parseSkill(text, d.name);
        byName.set(name.toLowerCase(), { id: `${scope}:${d.name}`, name, description, scope });
      } catch {
        /* no SKILL.md */
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('skills:read', async (_e, id, file) => {
  const [scope, dirName] = String(id).split(':');
  const root = skillRoots().find(([s]) => s === scope)?.[1];
  if (!root || !/^[\w. -]+$/.test(dirName || '')) throw new Error('Unknown skill');
  const base = path.join(root, dirName);
  const target = path.resolve(base, file || 'SKILL.md');
  if (path.relative(base, target).startsWith('..')) throw new Error('That file is outside the skill folder');
  const st = await fsp.stat(target);
  if (st.size > 200 * 1024) throw new Error('Skill file is too large');
  const text = await fsp.readFile(target, 'utf8');
  return { content: file ? text : parseSkill(text, dirName).body, files: await listSkillFiles(base) };
});

// Supporting files in a skill folder (relative, forward slashes), not counting SKILL.md.
async function listSkillFiles(base, rel = '', out = [], depth = 0) {
  if (depth > 3 || out.length >= 100) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(base, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await listSkillFiles(base, p, out, depth + 1);
    else if (e.isFile() && p !== 'SKILL.md') out.push(p);
  }
  return out;
}

// ---------- web research ----------
ipcMain.handle('web:search', (_e, query) => web.webSearch(loadSettings(), String(query || '').slice(0, 400)));
ipcMain.handle('web:fetch', (_e, url) => web.fetchPage(loadSettings(), url));

// ---------- MCP ----------
ipcMain.handle('mcp:list', () => mcp.describe());
ipcMain.handle('mcp:reconnect', () => mcp.connectAll(loadSettings().mcpServers));
ipcMain.handle('mcp:connectOne', (_e, cfg) => mcp.connectOne(cfg));
ipcMain.handle('mcp:disconnect', (_e, id) => mcp.disconnectOne(id));
ipcMain.handle('mcp:call', async (_e, name, args, timeout) => {
  try {
    return await mcp.callTool(name, args, { timeout });
  } catch (err) {
    return { text: `Error: ${err.message}`, isError: true };
  }
});

// ---------- project templates ----------
// Bundled starter trees under templates/. Install copies a template's files into the open
// project, skipping files that already exist so nothing is overwritten.
function templatesDir() {
  return path.join(__dirname, '..', 'templates');
}

ipcMain.handle('templates:list', async () => {
  let dirs = [];
  try {
    dirs = (await fsp.readdir(templatesDir(), { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(path.join(templatesDir(), d.name, 'template.json'), 'utf8'));
    } catch {
      /* no manifest */
    }
    out.push({ id: d.name, name: meta.name || d.name, description: meta.description || '', icon: meta.icon || 'sparkles', adds: meta.adds || '', then: meta.then || '' });
  }
  return out;
});

async function collectFiles(root, rel = '', out = []) {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await collectFiles(root, p, out);
    else if (e.isFile() && p !== 'template.json') out.push(p);
  }
  return out;
}

ipcMain.handle('templates:install', async (_e, id) => {
  if (!workspaceRoot) throw new Error('Open a project folder first.');
  if (!/^[\w.-]+$/.test(String(id))) throw new Error('Unknown template');
  const src = path.join(templatesDir(), id);
  try {
    await fsp.access(src);
  } catch {
    throw new Error('Unknown template');
  }
  const files = await collectFiles(src);
  const written = [];
  const skipped = [];
  for (const rel of files) {
    const dest = resolveInWorkspace(rel);
    try {
      await fsp.access(dest);
      skipped.push(rel);
      continue;
    } catch {
      /* does not exist, write it */
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(src, rel), dest);
    written.push(rel);
  }
  return { written, skipped };
});
