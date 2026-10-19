/* global monaco, marked, DOMPurify, require, api */
'use strict';

const $ = (sel) => document.querySelector(sel);
// `api` is the bridge exposed by preload.js (window.api).

const PROVIDERS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5-coder-7b-instruct' },
  dashscope: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder' },
  custom: { baseUrl: '', model: '' }
};
const MAX_AGENT_STEPS = 30;
const MAX_TOOL_RESULT = 24_000;
const MAX_ATTACH = 60_000;

const state = {
  settings: null,
  ws: null, // { root, name, sep, platform }
  tabs: [], // { path, model, savedVersion, viewState }
  active: null,
  selectedDir: '.',
  expanded: new Set(['.']),
  history: [], // OpenAI-format messages (without the system prompt)
  busy: false,
  stopRequested: false,
  currentChatId: null,
  attachCurrent: true
};

let editor;
let diffEditor;

// ===================================================================
// Boot
// ===================================================================
require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], async () => {
  state.settings = await api.getSettings();
  state.attachCurrent = state.settings.includeCurrentFile;

  editor = monaco.editor.create($('#editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: state.settings.fontSize,
    fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
  editor.onDidChangeCursorSelection(renderChips);

  bindUi();
  applySettingsToUi();
  initSplitters();
  checkConnection();

  if (state.settings.lastWorkspace) {
    await openWorkspace(state.settings.lastWorkspace, true);
  }
  renderWelcome();
});

// ===================================================================
// Workspace & file tree
// ===================================================================
async function openWorkspace(dir, silent) {
  const ws = await api.setWorkspace(dir);
  if (!ws) {
    if (!silent) alert(`Could not open folder:\n${dir}`);
    return;
  }
  for (const t of state.tabs) t.model.dispose();
  state.tabs = [];
  state.active = null;
  state.ws = ws;
  state.expanded = new Set(['.']);
  state.selectedDir = '.';
  $('#ws-name').textContent = ws.root;
  $('#term-shell').textContent = ws.platform === 'win32' ? '(cmd.exe)' : '(sh)';
  newChat();
  renderTabs();
  await renderTree();
  renderWelcome();
}

async function pickWorkspace() {
  const dir = await api.pickWorkspace();
  if (dir) await openWorkspace(dir);
}

function renderWelcome() {
  const show = !state.active;
  $('#welcome').classList.toggle('hidden', !show);
  const recent = $('#welcome-recent');
  recent.innerHTML = '';
  if (state.ws) {
    recent.textContent = `Project: ${state.ws.name} — pick a file from the explorer or ask Qwen.`;
  } else if (state.settings?.lastWorkspace) {
    const b = document.createElement('button');
    b.textContent = `Reopen ${state.settings.lastWorkspace}`;
    b.onclick = () => openWorkspace(state.settings.lastWorkspace);
    recent.append(b);
  }
}

async function renderTree() {
  const tree = $('#tree');
  if (!state.ws) {
    tree.innerHTML = '<div class="tree-empty">No folder open.</div>';
    return;
  }
  const ul = document.createElement('ul');
  await fillDir(ul, '.', 0);
  tree.replaceChildren(ul);
}

async function fillDir(ul, dirPath, depth) {
  let entries;
  try {
    entries = await api.list(dirPath);
  } catch (e) {
    ul.innerHTML = `<li class="tree-empty">${escapeHtml(e.message)}</li>`;
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.dataset.path = entry.path;
    const open = entry.dir && state.expanded.has(entry.path);
    row.innerHTML = `<span class="twisty">${entry.dir ? (open ? '▾' : '▸') : ''}</span><span class="icon">${entry.dir ? '📁' : fileIcon(entry.name)}</span><span class="label"></span>`;
    row.querySelector('.label').textContent = entry.name;
    if (!entry.dir && entry.path === state.active) row.classList.add('active');
    if (entry.dir && entry.path === state.selectedDir) row.classList.add('selected');
    li.append(row);

    if (entry.dir) {
      const child = document.createElement('ul');
      li.append(child);
      if (open) await fillDir(child, entry.path, depth + 1);
      row.onclick = async () => {
        state.selectedDir = entry.path;
        document.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
        row.classList.add('selected');
        if (state.expanded.has(entry.path)) {
          state.expanded.delete(entry.path);
          child.innerHTML = '';
          row.querySelector('.twisty').textContent = '▸';
        } else {
          state.expanded.add(entry.path);
          await fillDir(child, entry.path, depth + 1);
          row.querySelector('.twisty').textContent = '▾';
        }
      };
    } else {
      row.onclick = () => openFile(entry.path);
    }
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      showTreeMenu(ev, entry);
    };
    ul.append(li);
  }
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🟦', tsx: '⚛', jsx: '⚛', py: '🐍', json: '🔧', md: '📝',
    html: '🌐', css: '🎨', scss: '🎨', cs: '🟪', java: '☕', go: '🐹', rs: '🦀', cpp: '⚙', c: '⚙', h: '⚙',
    sh: '💲', ps1: '💲', bat: '💲', yml: '🔧', yaml: '🔧', toml: '🔧', png: '🖼', jpg: '🖼', svg: '🖼', txt: '📄'
  };
  return map[ext] || '📄';
}

function showTreeMenu(ev, entry) {
  const items = [];
  if (!entry.dir) {
    items.push(['Open', () => openFile(entry.path)]);
    items.push(['Add to chat', () => addFileToChat(entry.path)]);
  }
  const base = entry.dir ? entry.path : parentDir(entry.path);
  items.push(['New file here…', () => newFile(base)]);
  items.push(['New folder here…', () => newFolder(base)]);
  items.push(['Reveal in File Explorer', () => api.reveal(entry.path)]);
  items.push(['Delete', async () => {
    if (await api.remove(entry.path)) {
      const tab = state.tabs.find((t) => t.path === entry.path);
      if (tab) closeTab(tab.path, true);
      renderTree();
    }
  }]);
  showMenu(ev.clientX, ev.clientY, items);
}

function showMenu(x, y, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  for (const [label, fn] of items) {
    const d = document.createElement('div');
    d.textContent = label;
    d.onclick = () => {
      menu.classList.add('hidden');
      fn();
    };
    menu.append(d);
  }
  menu.style.left = `${Math.min(x, innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, innerHeight - items.length * 28 - 10)}px`;
  menu.classList.remove('hidden');
}

function parentDir(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}
function joinPath(dir, name) {
  return dir === '.' || !dir ? name : `${dir}/${name}`;
}

async function newFile(dir = state.selectedDir) {
  if (!requireWorkspace()) return;
  const name = await askInput('New file name', 'e.g. src/utils.js');
  if (!name) return;
  const p = joinPath(dir, name.replace(/\\/g, '/'));
  if (await api.exists(p)) return alert(`${p} already exists.`);
  await api.write(p, '');
  expandTo(p);
  await renderTree();
  openFile(p);
}

async function newFolder(dir = state.selectedDir) {
  if (!requireWorkspace()) return;
  const name = await askInput('New folder name', 'e.g. src/components');
  if (!name) return;
  const p = joinPath(dir, name.replace(/\\/g, '/'));
  await api.mkdir(p);
  expandTo(p + '/x');
  renderTree();
}

function expandTo(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join('/'));
}

function requireWorkspace() {
  if (state.ws) return true;
  pickWorkspace();
  return false;
}

// ===================================================================
// Editor tabs
// ===================================================================
async function openFile(path, { line } = {}) {
  let tab = state.tabs.find((t) => t.path === path);
  if (!tab) {
    let content;
    try {
      content = await api.read(path);
    } catch (e) {
      alert(e.message);
      return;
    }
    const uri = monaco.Uri.file('/' + path);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, undefined, uri);
    model.setValue(content);
    tab = { path, model, savedVersion: model.getAlternativeVersionId(), viewState: null };
    model.onDidChangeContent(() => renderTabs());
    state.tabs.push(tab);
  }
  activateTab(path);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }
}

function activateTab(path) {
  const current = state.tabs.find((t) => t.path === state.active);
  if (current) current.viewState = editor.saveViewState();
  const tab = state.tabs.find((t) => t.path === path);
  state.active = tab ? path : null;
  if (tab) {
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.focus();
  } else {
    editor.setModel(null);
  }
  document.querySelectorAll('.node').forEach((n) => n.classList.toggle('active', n.dataset.path === state.active));
  renderTabs();
  renderWelcome();
  renderChips();
}

function isDirty(tab) {
  return tab.model.getAlternativeVersionId() !== tab.savedVersion;
}

function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.path === state.active ? ' active' : '') + (isDirty(tab) ? ' dirty' : '');
    el.title = tab.path;
    const name = document.createElement('span');
    name.textContent = tab.path.split('/').pop();
    const close = document.createElement('button');
    close.className = 'close';
    close.innerHTML = '<span>✕</span>';
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    };
    el.onmousedown = (e) => {
      if (e.button === 1) closeTab(tab.path);
    };
    el.onclick = () => activateTab(tab.path);
    el.append(name, close);
    bar.append(el);
  }
}

function closeTab(path, force) {
  const i = state.tabs.findIndex((t) => t.path === path);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (!force && isDirty(tab) && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  state.tabs.splice(i, 1);
  tab.model.dispose();
  if (state.active === path) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    activateTab(next ? next.path : null);
  } else {
    renderTabs();
  }
}

async function saveActive() {
  const tab = state.tabs.find((t) => t.path === state.active);
  if (!tab) return;
  await api.write(tab.path, tab.model.getValue());
  tab.savedVersion = tab.model.getAlternativeVersionId();
  renderTabs();
  setStatus(`Saved ${tab.path}`);
}

// Called after Qwen writes a file, so open tabs show the new content (undoable with Ctrl+Z).
function syncOpenTab(path, content) {
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab || tab.model.getValue() === content) return;
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: content }], () => null);
  tab.savedVersion = tab.model.getAlternativeVersionId();
  renderTabs();
}

// ===================================================================
// Chat: context chips
// ===================================================================
const extraAttachments = new Set();

function renderChips() {
  const box = $('#context-chips');
  box.innerHTML = '';
  if (state.active) {
    const sel = editor.getSelection();
    const hasSel = sel && !sel.isEmpty();
    const chip = document.createElement('span');
    chip.className = 'chip' + (state.attachCurrent ? '' : ' off');
    chip.title = 'Click to toggle attaching the open file';
    chip.textContent = `📎 ${state.active.split('/').pop()}${hasSel ? ` (lines ${sel.startLineNumber}-${sel.endLineNumber})` : ''}`;
    chip.onclick = () => {
      state.attachCurrent = !state.attachCurrent;
      renderChips();
    };
    box.append(chip);
  }
  for (const p of extraAttachments) {
    if (p === state.active) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `📎 ${p}`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.onclick = () => {
      extraAttachments.delete(p);
      renderChips();
    };
    chip.append(x);
    box.append(chip);
  }
}

function addFileToChat(path) {
  extraAttachments.add(path);
  renderChips();
  $('#prompt').focus();
}

async function buildAttachments() {
  const parts = [];
  const names = [];
  const files = new Set(extraAttachments);
  if (state.active && state.attachCurrent) files.add(state.active);
  for (const p of files) {
    let text;
    const tab = state.tabs.find((t) => t.path === p);
    try {
      text = tab ? tab.model.getValue() : await api.read(p);
    } catch {
      continue;
    }
    if (text.length > MAX_ATTACH) text = text.slice(0, MAX_ATTACH) + '\n... [truncated]';
    let block = `File: ${p}\n\`\`\`${langOf(p)}\n${text}\n\`\`\``;
    if (p === state.active) {
      const sel = editor.getSelection();
      if (sel && !sel.isEmpty()) {
        block += `\n\nThe user has selected lines ${sel.startLineNumber}-${sel.endLineNumber} of ${p}:\n\`\`\`${langOf(p)}\n${tab.model.getValueInRange(sel)}\n\`\`\``;
      }
    }
    parts.push(block);
    names.push(p);
  }
  extraAttachments.clear();
  return { text: parts.join('\n\n'), names };
}

function langOf(p) {
  const ext = p.split('.').pop();
  return { js: 'javascript', ts: 'typescript', py: 'python', rs: 'rust', cs: 'csharp', md: 'markdown', sh: 'bash', ps1: 'powershell' }[ext] || ext;
}

// ===================================================================
// Chat: tools (agent mode)
// ===================================================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and folders in the project recursively (skips node_modules, .git and build output). Folders end with "/".',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder relative to the project root. Defaults to ".".' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project. Optionally read only a range of lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          start_line: { type: 'integer', description: '1-based first line (optional).' },
          end_line: { type: 'integer', description: '1-based last line, inclusive (optional).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search all project files for text (case-insensitive). Returns matching file:line entries.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression to search for.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file with the given content. Parent folders are created automatically. Prefer edit_file for small changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'The complete new file content.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact snippet in an existing file. old_text must match the file exactly (including indentation) and appear exactly once; include a few surrounding lines to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          old_text: { type: 'string', description: 'Exact existing text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project root and return its output (non-interactive, 2 minute timeout). Use it to install packages, build, run tests or scripts.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command line to run.' } }, required: ['command'] }
    }
  }
];

function systemPrompt() {
  const win = state.ws?.platform === 'win32';
  const lines = [
    'You are Qwen, an expert software engineer pair-programming with the user inside "Qwen Workspace", a desktop code editor.',
    state.ws ? `The user's project folder is: ${state.ws.root}` : 'No project folder is open yet.',
    `Operating system: ${win ? 'Windows (commands run in cmd.exe — use Windows syntax, e.g. "dir", "type", "&&")' : state.ws?.platform || 'unknown'}.`,
    state.active ? `The file currently open in the editor is: ${state.active}` : '',
    ''
  ];
  if (state.settings.agentMode && state.ws) {
    lines.push(
      'You can use tools to inspect and change the project. Guidelines:',
      '- Explore before you change things: use list_files, search_code and read_file to understand the relevant code. Never guess file contents.',
      '- Always read a file before editing it. Use edit_file for targeted changes and write_file for new files or full rewrites.',
      '- All paths are relative to the project root and use forward slashes.',
      '- The user must approve every edit and command; if they reject one, do not retry the same thing — ask what they want instead.',
      '- Make focused, minimal changes that match the existing code style. Do not create files the task does not need.',
      '- When you are done, reply with a short summary of what you changed and anything the user should do next.'
    );
  } else {
    lines.push(
      'Answer clearly and concisely. Use Markdown.',
      'When you provide the complete contents of a file, label the code fence with the language and the file path, like:',
      '```python src/main.py',
      'The user can then apply it to that file with one click. For partial snippets, use a normal fence with just the language.'
    );
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

function shortArg(name, args) {
  return args.path || args.command || args.query || (name === 'list_files' ? '.' : '');
}

async function executeTool(call, card) {
  const name = call.function.name;
  let args;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return `Error: arguments were not valid JSON: ${call.function.arguments.slice(0, 300)}`;
  }
  try {
    switch (name) {
      case 'list_files': {
        const r = await api.listRecursive(args.path || '.', 400);
        const out = r.files.join('\n') || '(empty)';
        card.setBody(out);
        return out + (r.truncated ? '\n... (truncated — list a subfolder for more)' : '');
      }
      case 'read_file': {
        const tab = state.tabs.find((t) => t.path === normPath(args.path));
        let text = tab ? tab.model.getValue() : await api.read(normPath(args.path));
        const all = text.split(/\r?\n/);
        let header = `${args.path} (${all.length} lines)`;
        if (args.start_line || args.end_line) {
          const s = Math.max(1, args.start_line || 1);
          const e = Math.min(all.length, args.end_line || all.length);
          text = all.slice(s - 1, e).join('\n');
          header += `, showing lines ${s}-${e}`;
        }
        card.setBody(text);
        return `${header}:\n${truncate(text)}`;
      }
      case 'search_code': {
        const hits = await api.search(args.query, { regex: !!args.regex, limit: 80 });
        const out = hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'No matches.';
        card.setBody(out);
        return out;
      }
      case 'write_file': {
        const p = normPath(args.path);
        const content = String(args.content ?? '');
        const exists = await api.exists(p);
        const original = exists ? await api.read(p) : '';
        if (exists && original === content) return 'File already has exactly this content; nothing changed.';
        const ok = await card.requestApproval({
          question: exists ? `Overwrite ${p}?` : `Create ${p}?`,
          preview: exists ? unifiedDiff(original, content) : content,
          isDiff: exists,
          diff: { path: p, original, modified: content },
          auto: state.settings.autoApproveEdits
        });
        if (!ok) return 'The user rejected this change. Do not retry it; ask the user how they would like to proceed.';
        await api.write(p, content);
        syncOpenTab(p, content);
        if (!exists) expandTo(p);
        renderTree();
        return `${exists ? 'Updated' : 'Created'} ${p} (${content.split('\n').length} lines).`;
      }
      case 'edit_file': {
        const p = normPath(args.path);
        const tab = state.tabs.find((t) => t.path === p);
        const original = tab ? tab.model.getValue() : await api.read(p);
        let oldText = String(args.old_text ?? '');
        let newText = String(args.new_text ?? '');
        if (!oldText) return 'Error: old_text is empty. Use write_file to create or overwrite a file.';
        if (!original.includes(oldText) && original.includes('\r\n')) {
          oldText = oldText.replace(/\r?\n/g, '\r\n');
          newText = newText.replace(/\r?\n/g, '\r\n');
        }
        const count = original.split(oldText).length - 1;
        if (count === 0) return `Error: old_text was not found in ${p}. Read the file again and copy the exact text, including whitespace.`;
        if (count > 1) return `Error: old_text matches ${count} places in ${p}. Include more surrounding lines so it is unique.`;
        const modified = original.replace(oldText, () => newText);
        const ok = await card.requestApproval({
          question: `Apply edit to ${p}?`,
          preview: unifiedDiff(original, modified),
          isDiff: true,
          diff: { path: p, original, modified },
          auto: state.settings.autoApproveEdits
        });
        if (!ok) return 'The user rejected this edit. Do not retry it; ask the user how they would like to proceed.';
        await api.write(p, modified);
        syncOpenTab(p, modified);
        return `Edited ${p}.`;
      }
      case 'run_command': {
        const cmd = String(args.command || '').trim();
        if (!cmd) return 'Error: empty command.';
        const ok = await card.requestApproval({ question: 'Run this command?', preview: cmd, auto: state.settings.autoApproveCommands });
        if (!ok) return 'The user declined to run this command. Do not retry it; ask the user how they would like to proceed.';
        showTerminal(true);
        termWrite(`\n> ${cmd}  (requested by Qwen)\n`, 'term-cmd');
        const r = await api.runCommand(cmd);
        termWrite(`[exit code ${r.code}]\n`, 'term-exit');
        card.setBody(r.output || '(no output)');
        return `Exit code: ${r.code}\n${truncate(r.output || '(no output)')}`;
      }
      default:
        return `Error: unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.function.name).join(', ')}.`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/').trim();
  if (state.ws) {
    const root = state.ws.root.replace(/\\/g, '/');
    if (s.toLowerCase().startsWith(root.toLowerCase() + '/')) s = s.slice(root.length + 1);
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '') || '.';
}

function truncate(s) {
  return s.length > MAX_TOOL_RESULT ? s.slice(0, MAX_TOOL_RESULT) + `\n... [truncated ${s.length - MAX_TOOL_RESULT} chars]` : s;
}

// Some Qwen builds emit tool calls as <tool_call>{...}</tool_call> text instead of structured tool_calls.
function extractTextToolCalls(content) {
  const calls = [];
  const cleaned = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, body) => {
    try {
      const obj = JSON.parse(body);
      if (obj.name) {
        calls.push({
          id: `call_txt_${Date.now()}_${calls.length}`,
          type: 'function',
          function: { name: obj.name, arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments || {}) }
        });
        return '';
      }
    } catch {
      /* leave it as text */
    }
    return _m;
  });
  return { calls, cleaned: cleaned.trim() };
}

// ===================================================================
// Chat: conversation loop
// ===================================================================
function newChat() {
  if (state.busy) stopChat();
  state.history = [];
  $('#messages').innerHTML = '';
  $('#messages').append(emptyState());
  setStatus('');
}

function emptyState() {
  const tpl = document.createElement('div');
  tpl.className = 'chat-empty';
  tpl.innerHTML = `<p><b>Ask Qwen anything about your project.</b></p>
    <div class="suggestions">
      <button data-prompt="Give me an overview of this project: what it does, how it's structured, and how to run it.">Explain this project</button>
      <button data-prompt="Review the current file for bugs and suggest improvements.">Review current file</button>
      <button data-prompt="Write unit tests for the current file.">Write tests</button>
      <button data-prompt="Find and fix the bug: ">Fix a bug…</button>
    </div>`;
  tpl.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('#prompt').value = b.dataset.prompt;
      $('#prompt').focus();
      if (!b.dataset.prompt.endsWith(': ')) send();
    };
  });
  return tpl;
}

async function send() {
  const input = $('#prompt');
  const text = input.value.trim();
  if (!text || state.busy) return;
  if (!state.ws && state.settings.agentMode) {
    // Plain chat works without a folder; agent tools need one.
    setStatus('Tip: open a folder so Qwen can work with your files.');
  }
  input.value = '';
  $('#chat-empty')?.remove();
  document.querySelector('#messages .chat-empty')?.remove();

  const att = await buildAttachments();
  addUserMessage(text, att.names);
  state.history.push({ role: 'user', content: att.text ? `${text}\n\n---\nAttached context:\n${att.text}` : text });

  setBusy(true);
  try {
    await runConversation();
  } finally {
    setBusy(false);
  }
}

async function runConversation() {
  const useTools = state.settings.agentMode && !!state.ws;
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (state.stopRequested) break;
    const view = addAssistantMessage();
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    state.currentChatId = id;
    setStatus(step === 0 ? 'Qwen is thinking…' : `Qwen is working… (step ${step + 1})`);

    const off = api.onChatEvent((ev) => {
      if (ev.id !== id) return;
      if (ev.type === 'delta') view.appendContent(ev.data);
      else if (ev.type === 'reasoning') view.appendReasoning(ev.data);
      else if (ev.type === 'tool_progress') setStatus(`Qwen is calling ${ev.data.join(', ')}…`);
    });
    const res = await api.chatStream(id, {
      messages: [{ role: 'system', content: systemPrompt() }, ...state.history],
      tools: useTools ? TOOLS : undefined
    });
    // IPC events and the invoke reply travel on separate channels, so late deltas can
    // arrive after this resolves. The reply carries the full text; use it as the final state.
    off();
    state.currentChatId = null;
    if (res.ok && !res.aborted) view.setFinal(res.content || '', res.reasoning || '');

    if (!res.ok) {
      view.finish();
      addError(res.error, useTools);
      break;
    }
    if (res.aborted) {
      view.finish();
      break;
    }

    let content = res.content || '';
    let calls = res.toolCalls || [];
    if (useTools && !calls.length && content.includes('<tool_call>')) {
      const parsed = extractTextToolCalls(content);
      calls = parsed.calls;
      content = parsed.cleaned;
      view.setContent(content);
    }
    view.finish();

    const msg = { role: 'assistant', content: stripThink(content) };
    if (calls.length) msg.tool_calls = calls;
    state.history.push(msg);
    if (!calls.length) break;

    for (const call of calls) {
      if (state.stopRequested) {
        state.history.push({ role: 'tool', tool_call_id: call.id, content: 'Cancelled by the user.' });
        continue;
      }
      const card = view.addToolCard(call);
      const result = await executeTool(call, card);
      card.done(result);
      state.history.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    if (step === MAX_AGENT_STEPS - 1) addError(`Stopped after ${MAX_AGENT_STEPS} steps. Send a message to let Qwen continue.`);
  }
  setStatus(state.stopRequested ? 'Stopped.' : '');
}

function stopChat() {
  state.stopRequested = true;
  if (state.currentChatId) api.chatAbort(state.currentChatId);
  document.querySelectorAll('.tool .approval button.reject').forEach((b) => b.click());
}

function setBusy(b) {
  state.busy = b;
  if (b) state.stopRequested = false;
  $('#btn-send').classList.toggle('hidden', b);
  $('#btn-stop').classList.toggle('hidden', !b);
}

function setStatus(t) {
  $('#status-text').textContent = t;
}

function stripThink(s) {
  return (s || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

// ===================================================================
// Chat: rendering
// ===================================================================
const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }) {
  const info = (lang || '').trim().split(/\s+/);
  const language = info[0] || '';
  const filePath = info.slice(1).join(' ').replace(/^(path|file)=/, '');
  return `<pre data-lang="${escapeAttr(language)}" data-path="${escapeAttr(filePath)}"><code>${escapeHtml(text)}</code></pre>`;
};
marked.setOptions({ renderer, gfm: true, breaks: false });

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['style', 'form', 'input'] });
  el.querySelectorAll('pre').forEach(decorateCodeBlock);
}

function decorateCodeBlock(pre) {
  const code = pre.querySelector('code');
  const text = code ? code.textContent : pre.textContent;
  const lang = pre.dataset.lang || '';
  const filePath = pre.dataset.path || '';
  const wrap = document.createElement('div');
  wrap.className = 'codeblock';
  const head = document.createElement('div');
  head.className = 'cb-head';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = filePath || lang || 'code';
  head.append(label);

  const mk = (txt, title, fn) => {
    const b = document.createElement('button');
    b.textContent = txt;
    b.title = title;
    b.onclick = fn;
    head.append(b);
    return b;
  };
  mk('Copy', 'Copy to clipboard', async (e) => {
    await navigator.clipboard.writeText(text);
    e.target.textContent = 'Copied ✓';
    setTimeout(() => (e.target.textContent = 'Copy'), 1200);
  });
  mk('Insert', 'Insert at the cursor / replace the selection in the editor', () => {
    if (!state.active) return alert('Open a file first.');
    const sel = editor.getSelection();
    editor.executeEdits('qwen', [{ range: sel, text, forceMoveMarkers: true }]);
    editor.focus();
  });
  if (filePath && state.ws) {
    mk('Apply to file', `Write this code to ${filePath} (shows a diff first)`, () => applyCodeToFile(normPath(filePath), text));
  }
  pre.replaceWith(wrap);
  wrap.append(head, pre);

  const monLang = monacoLang(lang);
  if (code && monLang) {
    monaco.editor.colorize(text, monLang, { tabSize: 2 }).then((html) => {
      code.innerHTML = html;
    });
  }
}

function monacoLang(lang) {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const alias = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp', rs: 'rust', yml: 'yaml', md: 'markdown', html: 'html', vue: 'html', golang: 'go', kt: 'kotlin', rb: 'ruby' };
  const id = alias[l] || l;
  return monaco.languages.getLanguages().some((x) => x.id === id) ? id : null;
}

async function applyCodeToFile(p, content) {
  const exists = await api.exists(p);
  const original = exists ? await api.read(p) : '';
  const ok = await showDiff(`${exists ? 'Apply changes to' : 'Create'} ${p}`, p, original, content, true);
  if (!ok) return;
  await api.write(p, content);
  syncOpenTab(p, content);
  expandTo(p);
  await renderTree();
  openFile(p);
  setStatus(`Wrote ${p}`);
}

function addUserMessage(text, attached) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  if (attached.length) {
    const a = document.createElement('span');
    a.className = 'attached';
    a.textContent = `📎 ${attached.join(', ')}`;
    el.append(a);
  }
  $('#messages').append(el);
  scrollChat(true);
}

function addError(text, usedTools) {
  const el = document.createElement('div');
  el.className = 'msg error';
  let hint = '';
  if (usedTools && /tool|function/i.test(text)) {
    hint = '\n\nThis model may not support tool calling. Turn off "Agent" mode in the chat header, or pick a tool-capable model such as qwen2.5-coder, qwen3 or qwen3-coder.';
  } else if (/connect|ECONNREFUSED|fetch failed/i.test(text)) {
    hint = '\n\nCheck Settings (⚙): is the base URL right and is the server running? For Ollama run "ollama serve" and "ollama pull ' + state.settings.model + '".';
  } else if (/401|403|api key|unauthorized/i.test(text)) {
    hint = '\n\nCheck the API key in Settings (⚙).';
  }
  el.textContent = text + hint;
  $('#messages').append(el);
  scrollChat(true);
}

function addAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  const think = document.createElement('details');
  think.className = 'think hidden';
  think.innerHTML = '<summary>Thinking…</summary><div class="think-body"></div>';
  const md = document.createElement('div');
  md.className = 'md cursor';
  const tools = document.createElement('div');
  el.append(think, md, tools);
  $('#messages').append(el);
  scrollChat(true);

  let content = '';
  let reasoning = '';
  let pending = false;

  const draw = () => {
    pending = false;
    // Split inline <think> blocks (Qwen3 / QwQ) out of the visible answer.
    let visible = content;
    let inlineThink = '';
    visible = visible.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t) => {
      inlineThink += t;
      return '';
    });
    const allThink = (reasoning + inlineThink).trim();
    if (allThink) {
      think.classList.remove('hidden');
      think.querySelector('.think-body').textContent = allThink;
    }
    renderMarkdown(md, visible.trim());
    scrollChat();
  };
  const schedule = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(draw);
    }
  };

  return {
    appendContent(t) {
      content += t;
      schedule();
    },
    appendReasoning(t) {
      reasoning += t;
      schedule();
    },
    setContent(t) {
      content = t;
      schedule();
    },
    setFinal(c, r) {
      content = c;
      reasoning = r;
      schedule();
    },
    finish() {
      draw();
      md.classList.remove('cursor');
      think.querySelector('summary').textContent = 'Thought process';
      if (!stripThink(content) && !md.textContent.trim()) md.classList.add('hidden');
    },
    addToolCard(call) {
      return makeToolCard(tools, call);
    }
  };
}

function makeToolCard(container, call) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    /* shown raw below */
  }
  const el = document.createElement('div');
  el.className = 'tool';
  el.innerHTML = '<div class="tool-head"><span>🔧</span><span class="tool-name"></span><span class="tool-arg"></span><span class="tool-status wait">running…</span></div><div class="tool-body"><pre></pre></div>';
  el.querySelector('.tool-name').textContent = call.function.name;
  el.querySelector('.tool-arg').textContent = shortArg(call.function.name, args);
  el.querySelector('.tool-head').onclick = () => el.classList.toggle('open');
  const status = el.querySelector('.tool-status');
  const body = el.querySelector('.tool-body pre');
  container.append(el);
  scrollChat();

  return {
    setBody(text) {
      body.textContent = text.length > 8000 ? text.slice(0, 8000) + '\n…' : text;
    },
    done(result) {
      const failed = /^Error|rejected|declined|Cancelled/.test(result);
      status.className = 'tool-status ' + (failed ? 'bad' : 'ok');
      status.textContent = failed ? (/rejected|declined/.test(result) ? 'rejected' : 'failed') : 'done';
      if (!body.textContent) body.textContent = result;
    },
    requestApproval({ question, preview, isDiff, diff, auto }) {
      if (isDiff) renderDiffPreview(body, preview);
      else body.textContent = preview;
      el.classList.add('open');
      if (auto) {
        status.textContent = 'auto-approved';
        return Promise.resolve(true);
      }
      status.textContent = 'waiting for you';
      setStatus('Waiting for your approval…');
      return new Promise((resolve) => {
        const bar = document.createElement('div');
        bar.className = 'approval';
        const q = document.createElement('span');
        q.className = 'q';
        q.textContent = question;
        bar.append(q);
        const finish = (v) => {
          bar.remove();
          el.classList.remove('open');
          setStatus(v ? 'Approved.' : 'Rejected.');
          resolve(v);
        };
        if (diff) {
          const view = document.createElement('button');
          view.textContent = 'View diff';
          view.onclick = async () => {
            const r = await showDiff(question, diff.path, diff.original, diff.modified, true);
            if (r !== null) finish(r);
          };
          bar.append(view);
        }
        const yes = document.createElement('button');
        yes.className = 'primary';
        yes.textContent = 'Approve';
        yes.onclick = () => finish(true);
        const no = document.createElement('button');
        no.className = 'reject';
        no.textContent = 'Reject';
        no.onclick = () => finish(false);
        bar.append(yes, no);
        el.append(bar);
        scrollChat(true);
        yes.focus();
      });
    }
  };
}

function renderDiffPreview(pre, diffText) {
  pre.innerHTML = '';
  for (const line of diffText.split('\n')) {
    const span = document.createElement('div');
    span.className = 'diff-line' + (line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : line.startsWith('@@') ? ' hunk' : '');
    span.textContent = line || ' ';
    pre.append(span);
  }
}

// Small line-based unified diff (LCS), good enough for previews of source files.
function unifiedDiff(a, b, context = 3) {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  if (A.length * B.length > 4_000_000) {
    return `(file too large for an inline diff — ${A.length} → ${B.length} lines; use "View diff")`;
  }
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push([' ', A[i], i, j]);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push(['+', B[j], i, j]);
      j++;
    } else {
      ops.push(['-', A[i], i, j]);
      i++;
    }
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run][0] === ' ') run++;
      if (run > context * 2 || end + run >= ops.length) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    out.push(`@@ line ${ops[start][2] + 1} @@`);
    for (let x = start; x < end; x++) out.push(ops[x][0] + ops[x][1]);
    k = end;
  }
  return out.join('\n') || '(no changes)';
}

function scrollChat(force) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// ===================================================================
// Diff modal
// ===================================================================
let diffResolve = null;
function showDiff(title, path, original, modified, withActions) {
  const modal = $('#diff-modal');
  $('#diff-title').textContent = title;
  modal.classList.remove('hidden');
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor($('#diff-editor'), { theme: 'vs-dark', automaticLayout: true, readOnly: true, renderSideBySide: true });
  }
  const old = diffEditor.getModel();
  const uriA = monaco.Uri.parse(`diff-a:/${path}?${Date.now()}`);
  const uriB = monaco.Uri.parse(`diff-b:/${path}?${Date.now()}`);
  const ext = '.' + path.split('.').pop().toLowerCase();
  const lang = monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext))?.id || 'plaintext';
  diffEditor.setModel({
    original: monaco.editor.createModel(original, lang, uriA),
    modified: monaco.editor.createModel(modified, lang, uriB)
  });
  old?.original.dispose();
  old?.modified.dispose();

  let actions = modal.querySelector('.diff-actions');
  actions?.remove();
  return new Promise((resolve) => {
    diffResolve = resolve;
    if (withActions) {
      actions = document.createElement('div');
      actions.className = 'modal-actions diff-actions';
      const no = document.createElement('button');
      no.textContent = 'Reject';
      const yes = document.createElement('button');
      yes.className = 'primary';
      yes.textContent = 'Approve & write file';
      no.onclick = () => closeDiff(false);
      yes.onclick = () => closeDiff(true);
      actions.append(no, yes);
      modal.querySelector('.modal-box').append(actions);
    }
  });
}
function closeDiff(result) {
  $('#diff-modal').classList.add('hidden');
  const r = diffResolve;
  diffResolve = null;
  r?.(result);
}

// ===================================================================
// Terminal
// ===================================================================
function showTerminal(show) {
  $('#terminal').classList.toggle('hidden', !show);
  if (show) $('#term-in').focus();
}
function termWrite(text, cls) {
  const out = $('#term-out');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  out.append(span);
  out.scrollTop = out.scrollHeight;
}
api.onCommandOutput((t) => termWrite(t));

async function runTerminalCommand(cmd) {
  if (!requireWorkspace()) return;
  termWrite(`\n> ${cmd}\n`, 'term-cmd');
  $('#term-in').disabled = true;
  const r = await api.runCommand(cmd, 10 * 60_000);
  termWrite(`[exit code ${r.code}]\n`, 'term-exit');
  $('#term-in').disabled = false;
  $('#term-in').focus();
  renderTree();
}

// ===================================================================
// Settings
// ===================================================================
function applySettingsToUi() {
  const s = state.settings;
  $('#model-name').textContent = s.model || 'no model';
  $('#agent-toggle').checked = s.agentMode;
  editor?.updateOptions({ fontSize: Number(s.fontSize) || 14 });
}

function openSettings() {
  const s = state.settings;
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'temperature', 'fontSize']) $(`#s-${k}`).value = s[k] ?? '';
  for (const k of ['agentMode', 'includeCurrentFile', 'autoApproveEdits', 'autoApproveCommands']) $(`#s-${k}`).checked = !!s[k];
  $('#s-test-result').textContent = '';
  $('#settings-modal').classList.remove('hidden');
}

async function saveSettingsFromUi() {
  const patch = {};
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model']) patch[k] = $(`#s-${k}`).value.trim();
  patch.temperature = parseFloat($('#s-temperature').value) || 0;
  patch.fontSize = parseInt($('#s-fontSize').value, 10) || 14;
  for (const k of ['agentMode', 'includeCurrentFile', 'autoApproveEdits', 'autoApproveCommands']) patch[k] = $(`#s-${k}`).checked;
  state.settings = await api.setSettings(patch);
  $('#settings-modal').classList.add('hidden');
  applySettingsToUi();
  checkConnection();
}

async function fetchModels() {
  const out = $('#s-test-result');
  out.className = 'hint';
  out.textContent = 'Connecting…';
  // Save the connection fields first so the main process uses them.
  await api.setSettings({ baseUrl: $('#s-baseUrl').value.trim(), apiKey: $('#s-apiKey').value.trim() });
  try {
    const models = await api.listModels();
    const dl = $('#model-list');
    dl.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      dl.append(o);
    }
    const qwen = models.filter((m) => /qwen/i.test(m));
    out.className = 'hint ok';
    out.textContent = `Connected ✓ ${models.length} models available${qwen.length ? `, Qwen: ${qwen.slice(0, 8).join(', ')}${qwen.length > 8 ? '…' : ''}` : ''}`;
    if (qwen.length && !qwen.includes($('#s-model').value)) $('#s-model').value = qwen[0];
  } catch (e) {
    out.className = 'hint bad';
    out.textContent = `Could not connect: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
}

async function checkConnection() {
  const dot = $('#conn-dot');
  dot.className = 'dot';
  try {
    const models = await api.listModels();
    const found = models.includes(state.settings.model);
    dot.className = 'dot ' + (found || !models.length ? 'ok' : 'bad');
    $('#btn-model').title = found || !models.length ? `Connected to ${state.settings.baseUrl}` : `Model "${state.settings.model}" not found on server. Click to choose another.`;
  } catch (e) {
    dot.className = 'dot bad';
    $('#btn-model').title = `Not connected: ${e.message}`;
  }
}

// ===================================================================
// Misc UI
// ===================================================================
let inputResolve = null;
function askInput(title, placeholder = '') {
  $('#input-title').textContent = title;
  const inp = $('#input-value');
  inp.value = '';
  inp.placeholder = placeholder;
  $('#input-modal').classList.remove('hidden');
  setTimeout(() => inp.focus(), 0);
  return new Promise((r) => (inputResolve = r));
}
function closeInput(v) {
  $('#input-modal').classList.add('hidden');
  inputResolve?.(v);
  inputResolve = null;
}

function initSplitters() {
  document.querySelectorAll('.splitter').forEach((sp) => {
    sp.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = $('#' + sp.dataset.target);
      const horizontal = sp.classList.contains('h');
      const start = horizontal ? e.clientY : e.clientX;
      const startSize = horizontal ? target.offsetHeight : target.offsetWidth;
      sp.classList.add('dragging');
      const move = (ev) => {
        const delta = (horizontal ? ev.clientY : ev.clientX) - start;
        if (horizontal) target.style.height = `${Math.max(80, startSize - delta)}px`;
        else target.style.width = `${Math.max(150, sp.dataset.side === 'right' ? startSize - delta : startSize + delta)}px`;
      };
      const up = () => {
        sp.classList.remove('dragging');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  });
}

function bindUi() {
  $('#btn-open').onclick = pickWorkspace;
  $('#welcome-open').onclick = pickWorkspace;
  $('#btn-new-file').onclick = () => newFile();
  $('#btn-new-folder').onclick = () => newFolder();
  $('#btn-refresh').onclick = renderTree;
  $('#btn-settings').onclick = openSettings;
  $('#btn-model').onclick = openSettings;
  $('#btn-terminal').onclick = () => showTerminal($('#terminal').classList.contains('hidden'));
  $('#btn-term-close').onclick = () => showTerminal(false);
  $('#btn-term-clear').onclick = () => ($('#term-out').innerHTML = '');
  $('#term-in').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      const cmd = e.target.value.trim();
      e.target.value = '';
      runTerminalCommand(cmd);
    }
  };

  $('#btn-new-chat').onclick = newChat;
  $('#btn-send').onclick = send;
  $('#btn-stop').onclick = stopChat;
  $('#agent-toggle').onchange = async (e) => {
    state.settings = await api.setSettings({ agentMode: e.target.checked });
  };
  $('#prompt').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  $('#messages').replaceChildren(emptyState());

  $('#s-provider').onchange = (e) => {
    const p = PROVIDERS[e.target.value];
    if (p.baseUrl) $('#s-baseUrl').value = p.baseUrl;
    if (p.model) $('#s-model').value = p.model;
  };
  $('#s-fetch-models').onclick = fetchModels;
  $('#s-save').onclick = saveSettingsFromUi;
  $('#s-cancel').onclick = () => $('#settings-modal').classList.add('hidden');

  $('#diff-close').onclick = () => closeDiff(null);
  $('#input-form').onsubmit = (e) => {
    e.preventDefault();
    closeInput($('#input-value').value.trim());
  };
  $('#input-cancel').onclick = () => closeInput(null);

  addEventListener('click', () => $('#ctx-menu').classList.add('hidden'));
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      $('#ctx-menu').classList.add('hidden');
      if (!$('#settings-modal').classList.contains('hidden')) $('#settings-modal').classList.add('hidden');
      if (!$('#diff-modal').classList.contains('hidden')) closeDiff(null);
      if (!$('#input-modal').classList.contains('hidden')) closeInput(null);
    }
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      pickWorkspace();
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveActive();
    }
    if (mod && e.key === '`') {
      e.preventDefault();
      showTerminal($('#terminal').classList.contains('hidden'));
    }
    if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      $('#prompt').focus();
    }
    if (mod && e.key.toLowerCase() === 'w' && state.active) {
      e.preventDefault();
      closeTab(state.active);
    }
  });
  addEventListener('beforeunload', (e) => {
    if (state.tabs.some(isDirty)) {
      e.returnValue = false;
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}
