/* global monaco, marked, DOMPurify, require, api, icon, iconEl, fileBadge, MODEL_CATALOG, recommendModels, describeSpecs, formatGB, formatContext */
'use strict';

// `api` is the bridge exposed by preload.js (window.api).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const PROVIDERS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5-coder-7b-instruct' },
  dashscope: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder' },
  custom: { baseUrl: '', model: '' }
};
const APPROVAL_MODES = {
  ask: { label: 'Ask', icon: 'shield', desc: 'Approve every file edit and command.' },
  edits: { label: 'Auto-edit', icon: 'shieldCheck', desc: 'Edits apply right away (revert them from Changes). Commands ask unless always-allowed.' },
  auto: { label: 'Full auto', icon: 'zap', desc: 'Edits and commands run without asking. Destructive commands still ask.' }
};
// Commands that always need approval, whatever the mode.
const DANGEROUS_COMMAND = /\b(rm\s+-[a-z]*[rf]|rmdir|rd\s+\/s|del\s|erase\s|format\s|mkfs|shutdown|reboot|reg\s+delete|remove-item|git\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D)|npm\s+publish|diskpart|bcdedit|takeown|icacls)\b/i;
const MAX_AGENT_STEPS = 40;
const MAX_TOOL_RESULT = 24_000;
const MAX_ATTACH = 60_000;

const state = {
  settings: null,
  ws: null, // { root, name, sep, platform }
  tabs: [], // { path, model, savedVersion, viewState, preview, decoIds }
  active: null,
  selectedDir: '.',
  expanded: new Set(['.']),
  view: 'explorer',
  history: [], // OpenAI-format messages (without the system prompt)
  busy: false,
  stopRequested: false,
  currentChatId: null,
  attachCurrent: true,
  changes: new Map(), // path -> { original: string|null, added, removed }
  notes: [], // things to tell Qwen with the next message (e.g. reverts)
  review: null, // { path, original, modified, pending, visible, title }
  pendingApproval: null, // { finish(bool), cancelOnClose }
  lastUsage: null,
  fileIndex: null,
  searchRegex: false,
  quick: { mode: 'open', items: [], sel: 0 },
  appInfo: null,
  update: { phase: 'idle', info: null, percent: 0, error: '' },
  specs: null,
  tags: null, // Ollama status and installed models
  pulls: new Map(), // model id -> { status, completed, total }
  warned: new Set() // one-time notices already shown this session
};

let editor;
let reviewEditor;
let reviewSideBySide = true;
const extraAttachments = new Set();

// ===================================================================
// Boot
// ===================================================================
require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], async () => {
  hydrateIcons(document);
  state.settings = await api.getSettings();
  state.attachCurrent = state.settings.includeCurrentFile;

  monaco.editor.defineTheme('qwen-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#18181c',
      'editorGutter.background': '#18181c',
      'minimap.background': '#18181c',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#4f4f5a',
      'editorLineNumber.activeForeground': '#c8c8d0',
      'editor.selectionBackground': '#8b6cff40',
      'editor.inactiveSelectionBackground': '#8b6cff22',
      'editorIndentGuide.background': '#26262d',
      'editorCursor.foreground': '#a892ff',
      'editorWidget.background': '#1d1d22',
      'editorWidget.border': '#3a3a44',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff22',
      'diffEditor.insertedLineBackground': '#3fb9501c',
      'diffEditor.removedLineBackground': '#f470671c',
      'diffEditor.insertedTextBackground': '#3fb95033',
      'diffEditor.removedTextBackground': '#f4706733'
    }
  });

  editor = monaco.editor.create($('#editor'), {
    theme: 'qwen-dark',
    automaticLayout: true,
    fontSize: state.settings.fontSize,
    fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
    fontLigatures: true,
    minimap: { enabled: true, renderCharacters: false, scale: 1 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    renderWhitespace: 'selection',
    padding: { top: 10 },
    tabSize: 2
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openQuick('open'));
  editor.onDidChangeCursorSelection(() => {
    renderChips();
    renderCursor();
  });
  editor.onDidChangeModel(renderCursor);

  bindUi();
  initSplitters();
  restoreLayout();
  applySettingsToUi();
  checkConnection();
  initUpdates();

  if (state.settings.lastWorkspace) await openWorkspace(state.settings.lastWorkspace, true);
  renderAll();
});

function hydrateIcons(root) {
  root.querySelectorAll('[data-icon]').forEach((s) => {
    s.innerHTML = icon(s.dataset.icon);
    s.classList.add('ico');
  });
}

function renderAll() {
  renderTree();
  renderTabs();
  renderCenter();
  renderChanges();
  renderChips();
  renderStatusbar();
  if (!state.history.length) renderChatEmpty();
}

// ===================================================================
// Workspace
// ===================================================================
async function openWorkspace(dir, silent) {
  if (state.busy) stopChat();
  const ws = await api.setWorkspace(dir);
  if (!ws) {
    if (!silent) alert(`Could not open folder:\n${dir}`);
    return;
  }
  for (const t of state.tabs) t.model.dispose();
  Object.assign(state, {
    tabs: [],
    active: null,
    ws,
    expanded: new Set(['.']),
    selectedDir: '.',
    fileIndex: null,
    notes: []
  });
  state.changes.clear();
  closeReview(true);
  state.settings = await api.getSettings();
  $('#term-shell').textContent = ws.platform === 'win32' ? '· cmd.exe' : '· sh';
  $('#term-out').innerHTML = '';
  newChat();
  renderAll();
}

async function pickWorkspace() {
  const dir = await api.pickWorkspace();
  if (dir) await openWorkspace(dir);
}

function requireWorkspace() {
  if (state.ws) return true;
  pickWorkspace();
  return false;
}

function showFolderMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const recent = (state.settings.recentWorkspaces || []).filter((p) => p !== state.ws?.root);
  const items = [{ label: 'Open Folder…', icon: 'folderOpen', detail: 'Ctrl+O', onClick: pickWorkspace }];
  if (recent.length) items.push('-');
  for (const p of recent) items.push({ label: baseName(p), detail: p, icon: 'history', onClick: () => openWorkspace(p) });
  showMenu(r.left, r.bottom + 4, items);
}

// ===================================================================
// Explorer
// ===================================================================
async function renderTree() {
  const tree = $('#tree');
  $('#explorer-title').textContent = state.ws ? state.ws.name : 'Explorer';
  if (!state.ws) {
    tree.replaceChildren(
      el('div', { class: 'empty-note' }, 'No folder open.', el('br'), el('button', { class: 'primary', onclick: pickWorkspace }, iconEl('folderOpen'), 'Open Folder'))
    );
    return;
  }
  const ul = el('ul');
  await fillDir(ul, '.', 0);
  tree.replaceChildren(ul);
}

async function fillDir(ul, dirPath, depth) {
  let entries;
  try {
    entries = await api.list(dirPath);
  } catch (e) {
    ul.replaceChildren(el('li', { class: 'empty-note', text: e.message }));
    return;
  }
  for (const entry of entries) {
    const open = entry.dir && state.expanded.has(entry.path);
    const ch = state.changes.get(entry.path);
    const row = el(
      'div',
      {
        class: `node${open ? ' open' : ''}${entry.path === state.active ? ' active' : ''}${entry.dir && entry.path === state.selectedDir ? ' selected' : ''}${ch ? (ch.original === null ? ' added' : ' changed') : ''}`,
        dataset: { path: entry.path },
        style: `padding-left:${6 + depth * 12}px`,
        title: entry.path
      },
      entry.dir ? iconEl('chevronRight', 'chev') : el('span', { class: 'chev' }),
      entry.dir ? iconEl(open ? 'folderOpen' : 'folder', 'folder-ico') : fileBadge(entry.name),
      el('span', { class: 'label', text: entry.name }),
      ch ? el('span', { class: 'mark', text: ch.original === null ? 'A' : 'M' }) : null
    );
    const li = el('li', {}, row);
    if (entry.dir) {
      const child = el('ul');
      li.append(child);
      if (open) await fillDir(child, entry.path, depth + 1);
      row.onclick = async () => {
        state.selectedDir = entry.path;
        $$('.node.selected').forEach((n) => n.classList.remove('selected'));
        row.classList.add('selected');
        if (state.expanded.has(entry.path)) {
          state.expanded.delete(entry.path);
          child.replaceChildren();
          row.classList.remove('open');
        } else {
          state.expanded.add(entry.path);
          await fillDir(child, entry.path, depth + 1);
          row.classList.add('open');
        }
        row.querySelector('.folder-ico').innerHTML = icon(row.classList.contains('open') ? 'folderOpen' : 'folder');
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

function showTreeMenu(ev, entry) {
  const items = [];
  if (!entry.dir) {
    items.push({ label: 'Open', icon: 'file', onClick: () => openFile(entry.path) });
    items.push({ label: 'Add to chat', icon: 'paperclip', onClick: () => addFileToChat(entry.path) });
    items.push('-');
  } else {
    items.push({ label: 'Ask Qwen about this folder', icon: 'sparkles', onClick: () => setPrompt(`Explain what the ${entry.path}/ folder contains and how it fits into the project.`, true) });
    items.push('-');
  }
  const base = entry.dir ? entry.path : parentDir(entry.path);
  items.push({ label: 'New file here…', icon: 'filePlus', onClick: () => newFile(base) });
  items.push({ label: 'New folder here…', icon: 'folderPlus', onClick: () => newFolder(base) });
  items.push({ label: 'Reveal in File Explorer', icon: 'external', onClick: () => api.reveal(entry.path) });
  items.push('-');
  items.push({
    label: 'Delete',
    icon: 'trash',
    onClick: async () => {
      if (await api.remove(entry.path)) {
        if (findTab(entry.path)) closeTab(entry.path, true);
        state.fileIndex = null;
        renderTree();
      }
    }
  });
  showMenu(ev.clientX, ev.clientY, items);
}

async function newFile(dir = state.selectedDir) {
  if (!requireWorkspace()) return;
  const name = await askInput('New file', 'e.g. src/utils.js');
  if (!name) return;
  const p = joinPath(dir, name.replace(/\\/g, '/'));
  if (await api.exists(p)) return alert(`${p} already exists.`);
  await api.write(p, '');
  expandTo(p);
  state.fileIndex = null;
  await renderTree();
  openFile(p);
}

async function newFolder(dir = state.selectedDir) {
  if (!requireWorkspace()) return;
  const name = await askInput('New folder', 'e.g. src/components');
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

// ===================================================================
// Side views
// ===================================================================
function showView(view, toggle) {
  const side = $('#sidepanel');
  if (toggle && state.view === view && !side.classList.contains('hidden')) {
    side.classList.add('hidden');
    $$('.act[data-view]').forEach((b) => b.classList.remove('active'));
    saveLayout();
    return;
  }
  state.view = view;
  side.classList.remove('hidden');
  $$('.act[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view === 'search') setTimeout(() => $('#search-input').focus(), 0);
  if (view === 'changes') renderChanges();
  saveLayout();
}

let searchTimer = null;
async function runSearch() {
  const q = $('#search-input').value;
  const out = $('#search-results');
  const summary = $('#search-summary');
  if (!q.trim() || !state.ws) {
    out.replaceChildren();
    summary.textContent = state.ws ? '' : 'Open a folder to search it.';
    return;
  }
  summary.textContent = 'Searching…';
  let hits;
  try {
    hits = await api.search(q, { regex: state.searchRegex, limit: 400 });
  } catch (e) {
    summary.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return;
  }
  if (q !== $('#search-input').value) return; // a newer search is running
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }
  summary.textContent = hits.length ? `${hits.length}${hits.length >= 400 ? '+' : ''} results in ${byFile.size} files` : 'No results.';
  const re = state.searchRegex ? safeRegex(q) : new RegExp(escapeRegex(q), 'ig');
  const frag = document.createDocumentFragment();
  for (const [path, list] of byFile) {
    frag.append(
      el('div', { class: 'sr-file', onclick: () => openFile(path, { line: list[0].line }), title: path },
        fileBadge(baseName(path)), el('span', { text: baseName(path) }), el('span', { class: 'dir', text: parentDir(path) === '.' ? '' : parentDir(path) }),
        el('span', { class: 'count', text: String(list.length) }))
    );
    for (const h of list) {
      const line = el('div', { class: 'sr-line', onclick: () => openFile(path, { line: h.line }), title: h.text }, el('span', { class: 'ln', text: String(h.line) }));
      const text = el('span');
      if (re) {
        let last = 0;
        h.text.replace(re, (m, ...rest) => {
          const idx = rest[rest.length - 2];
          text.append(h.text.slice(last, idx), el('mark', { text: m }));
          last = idx + m.length;
          return m;
        });
        text.append(h.text.slice(last));
      } else {
        text.textContent = h.text;
      }
      line.append(text);
      frag.append(line);
    }
  }
  out.replaceChildren(frag);
}

function safeRegex(q) {
  try {
    return new RegExp(q, 'ig');
  } catch {
    return null;
  }
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- changes made by Qwen ----------
function recordChange(path, before, after) {
  const prev = state.changes.get(path);
  const original = prev ? prev.original : before;
  if (original !== null && original === after) {
    state.changes.delete(path);
  } else {
    state.changes.set(path, { original, ...diffStats(original ?? '', after) });
  }
  renderChanges();
}

function renderChanges() {
  const n = state.changes.size;
  const badge = $('#changes-badge');
  badge.textContent = String(n);
  badge.classList.toggle('hidden', !n);
  $('#btn-revert-all').classList.toggle('hidden', !n);
  const list = $('#changes-list');
  if (!n) {
    list.replaceChildren(el('div', { class: 'empty-note', text: 'Files Qwen creates or edits in this session show up here. Click one to see the diff, or revert it.' }));
    return;
  }
  list.replaceChildren(...[...state.changes].map(([path, ch]) => changeItem(path, ch)));
}

function changeItem(path, ch) {
  const st = ch.original === null ? 'A' : 'M';
  return el(
    'div',
    { class: 'ch-item', title: path, onclick: () => openChangeReview(path) },
    el('span', { class: `st ${st}`, text: st, title: st === 'A' ? 'Added' : 'Modified' }),
    fileBadge(baseName(path)),
    el('span', { class: 'name', text: baseName(path) }),
    el('span', { class: 'dir', text: parentDir(path) === '.' ? '' : parentDir(path) }),
    el('span', { class: 'stats', html: statsHtml(ch) }),
    el('span', { class: 'acts' },
      el('button', { class: 'icon-btn', title: 'Open file', onclick: (e) => { e.stopPropagation(); openFile(path); } }, iconEl('file')),
      el('button', { class: 'icon-btn', title: 'Revert', onclick: (e) => { e.stopPropagation(); revertChange(path); } }, iconEl('undo')))
  );
}

function statsHtml({ added, removed }) {
  return `<span class="add">+${added}</span> <span class="del">−${removed}</span>`;
}

async function openChangeReview(path) {
  const ch = state.changes.get(path);
  if (!ch) return openFile(path);
  let current = '';
  try {
    current = findTab(path)?.model.getValue() ?? (await api.read(path));
  } catch {
    /* deleted since */
  }
  openReview({ path, original: ch.original ?? '', modified: current, pending: false, title: `${ch.original === null ? 'Created' : 'Changed'} ${path}` });
}

async function revertChange(path, ask = true) {
  const ch = state.changes.get(path);
  if (!ch) return;
  const what = ch.original === null ? `delete ${path} (Qwen created it)` : `restore ${path} to how it was before Qwen changed it`;
  if (ask && !confirm(`Revert: ${what}?`)) return;
  try {
    if (ch.original === null) {
      await api.remove(path, { quiet: true });
      if (findTab(path)) closeTab(path, true);
      state.fileIndex = null;
    } else {
      await api.write(path, ch.original);
      syncOpenTab(path, ch.original);
      clearHighlights(path);
    }
  } catch (e) {
    alert(`Could not revert ${path}: ${e.message}`);
    return;
  }
  state.changes.delete(path);
  state.notes.push(`The user reverted your changes to ${path}${ch.original === null ? ' (the file was deleted)' : ''}.`);
  if (state.review && !state.review.pending && state.review.path === path) closeReview(true);
  renderChanges();
  renderTree();
  renderCenter();
  flash(`Reverted ${path}`);
}

async function revertAll() {
  const n = state.changes.size;
  if (!n || !confirm(`Revert all ${n} files Qwen changed in this session?`)) return;
  for (const path of [...state.changes.keys()]) await revertChange(path, false);
}

// ===================================================================
// Editor, tabs, review
// ===================================================================
function findTab(path) {
  return state.tabs.find((t) => t.path === path);
}

async function openFile(path, { line, preview = false, focus = true } = {}) {
  let tab = findTab(path);
  if (!tab) {
    let content;
    try {
      content = await api.read(path);
    } catch (e) {
      if (focus) alert(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return false;
    }
    if (preview) {
      const old = state.tabs.find((t) => t.preview && !isDirty(t));
      if (old) closeTab(old.path, true, { keepActive: true });
    }
    const uri = monaco.Uri.file('/' + path);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, undefined, uri);
    model.setValue(content);
    tab = { path, model, savedVersion: model.getAlternativeVersionId(), viewState: null, preview, decoIds: [] };
    model.onDidChangeContent(() => {
      if (!tab.syncing) {
        tab.preview = false;
        clearHighlights(path);
      }
      renderTabs();
    });
    state.tabs.push(tab);
  } else if (!preview) {
    tab.preview = false;
  }
  activateTab(path, { focus });
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }
  return true;
}

function activateTab(path, { focus = true } = {}) {
  const current = findTab(state.active);
  if (current) current.viewState = editor.saveViewState();
  const tab = findTab(path);
  state.active = tab ? path : null;
  if (state.review) state.review.visible = false;
  if (tab) {
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    if (focus) editor.focus();
  } else {
    editor.setModel(null);
  }
  $$('.node').forEach((n) => n.classList.toggle('active', n.dataset.path === state.active));
  renderTabs();
  renderCenter();
  renderChips();
  renderCursor();
}

function isDirty(tab) {
  return tab.model.getAlternativeVersionId() !== tab.savedVersion;
}

function renderTabs() {
  const bar = $('#tabs');
  const nodes = state.tabs.map((tab) => {
    const active = tab.path === state.active && !state.review?.visible;
    return el(
      'div',
      {
        class: `tab${active ? ' active' : ''}${isDirty(tab) ? ' dirty' : ''}${tab.preview ? ' preview' : ''}`,
        title: tab.path,
        onclick: () => activateTab(tab.path),
        ondblclick: () => {
          tab.preview = false;
          renderTabs();
        },
        onmousedown: (e) => {
          if (e.button === 1) closeTab(tab.path);
        }
      },
      fileBadge(baseName(tab.path)),
      el('span', { class: 'name', text: baseName(tab.path) }),
      el('button', { class: 'close', title: 'Close (Ctrl+W)', onclick: (e) => { e.stopPropagation(); closeTab(tab.path); } }, iconEl('x'))
    );
  });
  if (state.review) {
    const r = state.review;
    nodes.push(
      el('div', { class: `tab review-tab${r.visible ? ' active' : ''}${r.pending ? ' pending' : ''}`, title: r.title, onclick: () => showReview() },
        iconEl('changes'),
        el('span', { class: 'name', text: `${r.pending ? 'Review' : 'Diff'}: ${baseName(r.path)}` }),
        el('button', { class: 'close', title: 'Close', onclick: (e) => { e.stopPropagation(); closeReview(); } }, iconEl('x')))
    );
  }
  bar.replaceChildren(...nodes);
  bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(path, force, { keepActive } = {}) {
  const i = state.tabs.findIndex((t) => t.path === path);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (!force && isDirty(tab) && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  state.tabs.splice(i, 1);
  if (state.active === path && !keepActive) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    activateTab(next ? next.path : null);
  } else if (state.active === path) {
    state.active = null;
  }
  tab.model.dispose();
  renderTabs();
  renderCenter();
}

async function saveActive() {
  const tab = findTab(state.active);
  if (!tab) return;
  await api.write(tab.path, tab.model.getValue());
  tab.savedVersion = tab.model.getAlternativeVersionId();
  tab.preview = false;
  renderTabs();
  flash(`Saved ${tab.path}`);
}

// Called after Qwen writes a file, so open tabs show the new content (undoable with Ctrl+Z).
function syncOpenTab(path, content) {
  const tab = findTab(path);
  if (!tab || tab.model.getValue() === content) return;
  tab.syncing = true;
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: content }], () => null);
  tab.syncing = false;
  tab.savedVersion = tab.model.getAlternativeVersionId();
  renderTabs();
}

// Marks the lines Qwen just added or changed, until the user edits the file.
function highlightChanges(path, before, after) {
  const tab = findTab(path);
  if (!tab) return;
  const ops = diffOps(before ?? '', after);
  if (!ops) return;
  const lineCount = tab.model.getLineCount();
  const decos = [];
  for (const [op, , , j] of ops) {
    if (op === '+') {
      decos.push({
        range: new monaco.Range(j + 1, 1, j + 1, 1),
        options: { isWholeLine: true, className: 'qw-added', linesDecorationsClassName: 'qw-gutter-add', overviewRuler: { color: '#3fb950', position: monaco.editor.OverviewRulerLane.Left } }
      });
    } else if (op === '-') {
      const line = Math.max(1, Math.min(j + 1, lineCount));
      decos.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: 'qw-gutter-del', overviewRuler: { color: '#f47067', position: monaco.editor.OverviewRulerLane.Left } } });
    }
  }
  tab.decoIds = tab.model.deltaDecorations(tab.decoIds || [], decos);
  const first = decos[0]?.range.startLineNumber;
  if (first && state.active === path) editor.revealLineInCenterIfOutsideViewport(first);
}

function clearHighlights(path) {
  const tab = findTab(path);
  if (tab?.decoIds?.length) tab.decoIds = tab.model.deltaDecorations(tab.decoIds, []);
}

function languageForPath(path) {
  const ext = '.' + path.split('.').pop().toLowerCase();
  const name = baseName(path).toLowerCase();
  return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.map((f) => f.toLowerCase()).includes(name))?.id || 'plaintext';
}

function openReview({ path, original, modified, pending, title }) {
  if (!reviewEditor) {
    reviewEditor = monaco.editor.createDiffEditor($('#review-editor'), {
      theme: 'qwen-dark',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: reviewSideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: Number(state.settings.fontSize) || 14,
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      hideUnchangedRegions: { enabled: true }
    });
  }
  const old = reviewEditor.getModel();
  const lang = languageForPath(path);
  const stamp = Date.now();
  reviewEditor.setModel({
    original: monaco.editor.createModel(original ?? '', lang, monaco.Uri.parse(`review-a:/${stamp}/${path}`)),
    modified: monaco.editor.createModel(modified, lang, monaco.Uri.parse(`review-b:/${stamp}/${path}`))
  });
  old?.original.dispose();
  old?.modified.dispose();

  state.review = { path, original, modified, pending, visible: true, title: title || path };
  $('#review-title').textContent = state.review.title;
  $('#review-stats').innerHTML = statsHtml(diffStats(original ?? '', modified));
  $('.review-bar').classList.toggle('pending', !!pending);
  const actions = $('#review-actions');
  if (pending) {
    actions.replaceChildren(
      el('button', { class: 'ghost danger-text', onclick: () => state.pendingApproval?.finish(false) }, 'Reject'),
      el('button', { class: 'primary', onclick: () => state.pendingApproval?.finish(true) }, iconEl('check'), 'Approve')
    );
  } else {
    actions.replaceChildren(
      el('button', { class: 'ghost', onclick: () => openFile(path) }, iconEl('file'), 'Open file'),
      state.changes.has(path) ? el('button', { class: 'ghost', onclick: () => revertChange(path) }, iconEl('undo'), 'Revert') : null
    );
  }
  renderTabs();
  renderCenter();
}

function showReview() {
  if (!state.review) return;
  state.review.visible = true;
  renderTabs();
  renderCenter();
}

function closeReview(force) {
  if (!state.review) return;
  if (!force && state.review.pending && state.pendingApproval?.cancelOnClose) {
    state.pendingApproval.finish(false);
    return;
  }
  state.review = null;
  renderTabs();
  renderCenter();
}

function renderCenter() {
  const showRev = !!state.review?.visible;
  $('#review').classList.toggle('hidden', !showRev);
  $('#editor').classList.toggle('hidden', showRev || !state.active);
  $('#home').classList.toggle('hidden', showRev || !!state.active);
  if (!showRev && !state.active) renderHome();
}

// ===================================================================
// Home screen (shown when no file is open)
// ===================================================================
const QUICK_ACTIONS = [
  { icon: 'book', title: 'Explain this project', desc: 'What it does, how it is organised and how to build it.', prompt: 'Give me an overview of this project: what it does, how it is structured, and how to build and run it.' },
  { icon: 'bug', title: 'Find bugs', desc: 'Review the code for likely bugs and risky spots.', prompt: 'Look through the main source files for likely bugs or risky code, and list the most important ones with file and line.' },
  { icon: 'wand', title: 'Add a feature', desc: 'Describe what you want and let Qwen build it.', prompt: 'Add this feature: ', fill: true },
  { icon: 'play', title: 'Build & run', desc: 'Work out the build steps and run them.', prompt: 'Figure out how to build this project on this machine, then build it and fix any errors.' }
];

function renderHome() {
  const home = $('#home');
  const inner = el('div', { class: 'home-inner' });
  if (!state.ws) {
    const recent = state.settings?.recentWorkspaces || [];
    inner.append(
      el('div', { class: 'hero' },
        el('span', { class: 'logo', text: 'Q' }),
        el('h1', { text: 'Qwen Workspace' }),
        el('p', { text: 'Open a project folder, then ask Qwen to build, fix or explain your code.' }),
        el('button', { class: 'primary', onclick: pickWorkspace }, iconEl('folderOpen'), 'Open Folder'))
    );
    if (recent.length) {
      inner.append(
        el('div', { class: 'home-section' }, el('h3', { text: 'Recent' }),
          ...recent.map((p) => el('button', { class: 'recent-item', onclick: () => openWorkspace(p), title: p },
            iconEl('folder'), el('span', { class: 'name', text: baseName(p) }), el('span', { class: 'path', text: p }))))
      );
    }
  } else {
    inner.append(
      el('div', { class: 'proj-head' },
        el('div', { class: 'big-ico' }, iconEl('folder')),
        el('div', {}, el('h1', { text: state.ws.name }), el('div', { class: 'path', text: state.ws.root }))),
      el('div', { class: 'home-section' }, el('h3', { text: 'Ask Qwen' }),
        el('div', { class: 'actions-grid' },
          ...QUICK_ACTIONS.map((a) => el('button', { class: 'action-card', onclick: () => setPrompt(a.prompt, !a.fill) },
            iconEl(a.icon), el('span', { class: 't', text: a.title }), el('span', { class: 'd', text: a.desc })))))
    );
    if (state.changes.size) {
      inner.append(el('div', { class: 'home-section' }, el('h3', { text: `Changed by Qwen (${state.changes.size})` }),
        ...[...state.changes].map(([p, ch]) => changeItem(p, ch))));
    }
    inner.append(
      el('div', { class: 'home-tips' },
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>P</kbd> go to file' }),
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd> search' }),
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>`</kbd> terminal' }),
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>L</kbd> chat' }))
    );
  }
  home.replaceChildren(inner);
}

// ===================================================================
// Chat: attachments
// ===================================================================
function renderChips() {
  const box = $('#context-chips');
  const chips = [];
  if (state.active) {
    const sel = editor.getSelection();
    const hasSel = sel && !sel.isEmpty();
    chips.push(
      el('span', {
        class: `chip${state.attachCurrent ? '' : ' off'}`,
        title: state.attachCurrent ? 'The open file is attached. Click to detach.' : 'Click to attach the open file',
        onclick: () => {
          state.attachCurrent = !state.attachCurrent;
          renderChips();
        }
      }, fileBadge(baseName(state.active)), el('span', { class: 'label', text: `${baseName(state.active)}${hasSel ? ` · lines ${sel.startLineNumber}–${sel.endLineNumber}` : ''}` }))
    );
  }
  for (const p of extraAttachments) {
    if (p === state.active) continue;
    chips.push(
      el('span', { class: 'chip', title: p }, fileBadge(baseName(p)), el('span', { class: 'label', text: p }),
        el('button', { title: 'Remove', onclick: () => { extraAttachments.delete(p); renderChips(); } }, iconEl('x')))
    );
  }
  box.replaceChildren(...chips);
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
    const tab = findTab(p);
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
      description: 'List files and folders in a project folder (skips node_modules, .git and build output). Folders end with "/". Starts shallow; list a subfolder or raise depth to see more.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the project root. Defaults to ".".' },
          depth: { type: 'integer', description: 'How many folder levels to descend (1-6). Defaults to 2.' }
        }
      }
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

const TOOL_INFO = {
  list_files: { icon: 'list', verb: 'List', doing: 'Listing' },
  read_file: { icon: 'eye', verb: 'Read', doing: 'Reading' },
  search_code: { icon: 'search', verb: 'Search', doing: 'Searching for' },
  write_file: { icon: 'filePlus', verb: 'Write', doing: 'Writing' },
  edit_file: { icon: 'pencil', verb: 'Edit', doing: 'Editing' },
  run_command: { icon: 'terminal', verb: 'Run', doing: 'Running' }
};

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
      "- Tool results are produced by the tools you call, not pasted by the user. Use them to keep working on the user's request.",
      '- Keep going with tool calls until the task is done; do not stop to describe what you are about to do.',
      '- If the user rejects an edit or command, do not retry the same thing — ask what they want instead.',
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
  return lines.join('\n');
}

function describeCall(name, args) {
  switch (name) {
    case 'list_files': {
      const p = normPath(args.path || '.');
      return { target: p === '.' ? 'project root' : `${p}/` };
    }
    case 'read_file': {
      const p = normPath(args.path);
      const range = args.start_line || args.end_line ? ` · lines ${args.start_line || 1}–${args.end_line || 'end'}` : '';
      return { target: baseName(p) + range, path: p, title: p };
    }
    case 'search_code':
      return { target: `“${args.query || ''}”` };
    case 'write_file':
    case 'edit_file': {
      const p = normPath(args.path);
      return { target: baseName(p), path: p, title: p };
    }
    case 'run_command':
      return { target: args.command || '', mono: true, title: args.command };
    default:
      return { target: '' };
  }
}

// ---------- approvals ----------
function approvalMode() {
  return APPROVAL_MODES[state.settings.approvalMode] ? state.settings.approvalMode : 'edits';
}

function commandPrefix(cmd) {
  const words = cmd.trim().split(/\s+/);
  const twoWord = /^(git|npm|npx|yarn|pnpm|pip|pip3|python|python3|py|cargo|dotnet|go|node|cmake|make|msbuild|gradle|mvn)$/i;
  return (twoWord.test(words[0]) && words[1] && !words[1].startsWith('-') ? words.slice(0, 2) : words.slice(0, 1)).join(' ');
}

function isAllowedCommand(cmd) {
  const c = cmd.trim().toLowerCase();
  return (state.settings.allowedCommands || []).some((p) => {
    const pre = p.trim().toLowerCase();
    return pre && (c === pre || c.startsWith(pre + ' '));
  });
}

function needsApproval(kind, command) {
  const mode = approvalMode();
  if (kind === 'edit') return mode === 'ask';
  if (DANGEROUS_COMMAND.test(command)) return true;
  if (mode === 'auto') return false;
  return mode === 'ask' || !isAllowedCommand(command);
}

async function allowCommandPrefix(prefix) {
  const list = state.settings.allowedCommands || [];
  if (!list.includes(prefix)) state.settings = await api.setSettings({ allowedCommands: [...list, prefix] });
  flash(`"${prefix}" commands will run without asking`);
}

// ---------- tool execution ----------
async function executeTool(call, row) {
  const name = call.function.name;
  let args;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { result: `Error: arguments were not valid JSON: ${call.function.arguments.slice(0, 300)}` };
  }
  const follow = state.settings.followAgent;
  try {
    switch (name) {
      case 'list_files': {
        const depth = Math.min(6, Math.max(1, parseInt(args.depth, 10) || 2));
        const r = await api.listRecursive(normPath(args.path || '.'), 200, depth);
        const out = r.files.join('\n') || '(empty)';
        row.setBody(out);
        return { result: out + (r.truncated ? '\n... (truncated at 200 entries — list a subfolder for more)' : ''), meta: `${r.files.length}${r.truncated ? '+' : ''} items` };
      }
      case 'read_file': {
        const p = normPath(args.path);
        const tab = findTab(p);
        let text = tab ? tab.model.getValue() : await api.read(p);
        const all = text.split(/\r?\n/);
        const lineCount = all.length - (all[all.length - 1] === '' ? 1 : 0);
        let header = `${p} (${lineCount} lines)`;
        let start = null;
        if (args.start_line || args.end_line) {
          start = Math.max(1, args.start_line || 1);
          const end = Math.min(all.length, args.end_line || all.length);
          text = all.slice(start - 1, end).join('\n');
          header += `, showing lines ${start}-${end}`;
        }
        row.setBody(text);
        if (follow) openFile(p, { preview: true, focus: false, line: start });
        return { result: `${header}:\n${truncate(text)}`, meta: `${lineCount} lines` };
      }
      case 'search_code': {
        const hits = await api.search(args.query, { regex: !!args.regex, limit: 80 });
        const out = hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : 'No matches.';
        row.setBody(out);
        return { result: out, meta: `${hits.length}${hits.length >= 80 ? '+' : ''} matches` };
      }
      case 'write_file': {
        const p = normPath(args.path);
        const content = String(args.content ?? '');
        const exists = await api.exists(p);
        const original = exists ? findTab(p)?.model.getValue() ?? (await api.read(p)) : '';
        if (exists && original === content) return { result: 'File already has exactly this content; nothing changed.', meta: 'no change' };
        row.setVerb(exists ? 'Rewrite' : 'Create');
        return applyAgentEdit(row, p, exists ? original : null, content, exists ? `Rewrite ${p}` : `Create ${p}`);
      }
      case 'edit_file': {
        const p = normPath(args.path);
        const original = findTab(p)?.model.getValue() ?? (await api.read(p));
        let oldText = String(args.old_text ?? '');
        let newText = String(args.new_text ?? '');
        if (!oldText) return { result: 'Error: old_text is empty. Use write_file to create or overwrite a file.' };
        if (!original.includes(oldText) && original.includes('\r\n')) {
          oldText = oldText.replace(/\r?\n/g, '\r\n');
          newText = newText.replace(/\r?\n/g, '\r\n');
        }
        const count = original.split(oldText).length - 1;
        if (count === 0) return { result: `Error: old_text was not found in ${p}. Read the file again and copy the exact text, including whitespace.` };
        if (count > 1) return { result: `Error: old_text matches ${count} places in ${p}. Include more surrounding lines so it is unique.` };
        const modified = original.replace(oldText, () => newText);
        return applyAgentEdit(row, p, original, modified, `Edit ${p}`);
      }
      case 'run_command': {
        const cmd = String(args.command || '').trim();
        if (!cmd) return { result: 'Error: empty command.' };
        if (needsApproval('command', cmd)) {
          const ok = await row.requestApproval({ kind: 'command', question: 'Run this command?', command: cmd, dangerous: DANGEROUS_COMMAND.test(cmd) });
          if (!ok) return { result: 'The user declined to run this command. Do not retry it; ask the user how they would like to proceed.', rejected: true };
        }
        showTerminal(true, false);
        termWrite(`\n❯ ${cmd}  (Qwen)\n`, 'term-cmd');
        setActivity(`Running ${cmd}`);
        const r = await api.runCommand(cmd);
        termWrite(`[exit code ${r.code}]\n`, 'term-exit');
        row.setBody(r.output || '(no output)');
        state.fileIndex = null;
        renderTree();
        return { result: `Exit code: ${r.code}\n${truncate(r.output || '(no output)')}`, meta: `exit ${r.code}`, failed: r.code !== 0 };
      }
      default:
        return { result: `Error: unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.function.name).join(', ')}.` };
    }
  } catch (e) {
    return { result: `Error: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` };
  }
}

// Shared by write_file and edit_file. `before` is null for a new file.
async function applyAgentEdit(row, p, before, after, title) {
  const stats = diffStats(before ?? '', after);
  row.setDiffBody(unifiedDiff(before ?? '', after));
  if (needsApproval('edit')) {
    const ok = await row.requestApproval({ kind: 'edit', question: title, path: p, original: before ?? '', modified: after, stats });
    if (!ok) return { result: 'The user rejected this change. Do not retry it; ask the user how they would like to proceed.', rejected: true };
  }
  await api.write(p, after);
  syncOpenTab(p, after);
  recordChange(p, before, after);
  if (before === null) {
    expandTo(p);
    state.fileIndex = null;
  }
  renderTree();
  if (state.settings.followAgent) {
    await openFile(p, { preview: true, focus: false });
    highlightChanges(p, before, after);
  }
  row.onTarget(() => openChangeReview(p));
  const verb = before === null ? 'Created' : 'Edited';
  return { result: `${verb} ${p} (${after.split('\n').length} lines, +${stats.added} −${stats.removed}).`, metaHtml: statsHtml(stats) };
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

// Some Qwen builds put tool calls in the text instead of structured tool_calls, either as
// JSON (<tool_call>{"name": ..., "arguments": {...}}</tool_call>) or in Qwen3-Coder's XML
// style (<function=name><parameter=key>value</parameter></function>), sometimes with
// closing tags missing.
const TOOL_TEXT_MARKER = /<tool_call>|<function=[\w.-]+>/;
const MULTILINE_PARAMS = new Set(['content', 'old_text', 'new_text']);

function textToolCallStart(content) {
  const m = TOOL_TEXT_MARKER.exec(content);
  return m ? m.index : -1;
}

function extractTextToolCalls(content) {
  const start = textToolCallStart(content);
  if (start < 0) return { calls: [], cleaned: content.trim() };
  const tail = content.slice(start);
  const calls = [];
  const add = (name, args) =>
    calls.push({ id: `call_txt_${Date.now()}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } });

  if (tail.includes('<function=')) {
    for (const block of tail.split(/(?=<function=)/)) {
      const fm = /^<function=([\w.-]+)>/.exec(block);
      if (!fm) continue;
      const args = {};
      const re = /<parameter=([\w.-]+)>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|<\/tool_call>|$)/g;
      let pm;
      while ((pm = re.exec(block))) {
        const key = pm[1];
        let v = pm[2];
        v = MULTILINE_PARAMS.has(key) ? v.replace(/^\r?\n/, '').replace(/\r?\n$/, '') : v.trim();
        if (/^(start_line|end_line|depth)$/.test(key) && /^\d+$/.test(v)) v = Number(v);
        else if (v === 'true' || v === 'false') v = v === 'true';
        args[key] = v;
      }
      add(fm[1], args);
    }
  } else {
    const re = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
    let m;
    while ((m = re.exec(tail)) && m[0]) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj.name) add(obj.name, typeof obj.arguments === 'string' ? JSON.parse(obj.arguments) : obj.arguments);
      } catch {
        /* not JSON; ignore */
      }
    }
  }
  return calls.length ? { calls, cleaned: content.slice(0, start).trim() } : { calls, cleaned: content.trim() };
}

// ===================================================================
// Chat: conversation loop
// ===================================================================
function newChat() {
  if (state.busy) stopChat();
  state.history = [];
  state.lastUsage = null;
  $('#chat-title').textContent = 'New chat';
  renderChatEmpty();
  updateCtxMeter();
  setActivity('');
}

function renderChatEmpty() {
  const suggestions = [
    ['book', 'Explain this project', "Give me an overview of this project: what it does, how it's structured, and how to build and run it."],
    ['eye', 'Review the open file', 'Review the open file for bugs and suggest improvements.'],
    ['bug', 'Fix a bug…', 'Find and fix this bug: ', true],
    ['wand', 'Add a feature…', 'Add this feature: ', true]
  ];
  $('#messages').replaceChildren(
    el('div', { class: 'chat-empty' },
      el('span', { class: 'logo', text: 'Q' }),
      el('h2', { text: state.ws ? `What should we do in ${state.ws.name}?` : 'What are we building?' }),
      el('p', { text: state.ws ? 'Qwen can read, search and edit this project.' : 'Open a folder so Qwen can work with your files.' }),
      el('div', { class: 'suggestions' }, ...suggestions.map(([ic, label, prompt, fill]) =>
        el('button', { onclick: () => setPrompt(prompt, !fill) }, iconEl(ic), label))))
  );
}

function setPrompt(text, sendNow) {
  const input = $('#prompt');
  input.value = text;
  autoGrow();
  input.focus();
  input.setSelectionRange(text.length, text.length);
  if (sendNow) send();
}

async function send() {
  const input = $('#prompt');
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = '';
  autoGrow();
  $('#messages .chat-empty')?.remove();
  if (!state.history.length) $('#chat-title').textContent = text.length > 60 ? text.slice(0, 57) + '…' : text;

  const att = await buildAttachments();
  renderChips();
  addUserMessage(text, att.names);
  let content = text;
  if (state.notes.length) {
    content = `(Note: ${state.notes.join(' ')})\n\n${content}`;
    state.notes = [];
  }
  if (att.text) content += `\n\n---\nAttached context:\n${att.text}`;
  state.history.push({ role: 'user', content });

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
    setActivity(step === 0 ? 'Thinking' : 'Working');

    const off = api.onChatEvent((ev) => {
      if (ev.id !== id) return;
      if (ev.type === 'delta') view.appendContent(ev.data);
      else if (ev.type === 'reasoning') view.appendReasoning(ev.data);
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
    if (res.usage?.promptTokens && res.usage.contextLength) {
      state.lastUsage = res.usage;
      updateCtxMeter();
      if (res.usage.promptTokens >= res.usage.contextLength * 0.95) {
        addError(`The conversation (${res.usage.promptTokens.toLocaleString()} tokens) has filled Qwen's context window (${res.usage.contextLength.toLocaleString()}), so the oldest messages — including your instructions — were cut off. Raise "Context window" in Settings or start a new chat.`);
      }
    }

    if (!res.ok) {
      view.finish(false);
      addError(res.error, useTools);
      break;
    }
    if (res.aborted) {
      view.finish(false);
      break;
    }

    let content = res.content || '';
    let calls = res.toolCalls || [];
    if (useTools && !calls.length && textToolCallStart(content) >= 0) {
      const parsed = extractTextToolCalls(content);
      calls = parsed.calls;
      content = parsed.cleaned;
      view.setContent(content);
    }
    view.finish(calls.length > 0);

    const msg = { role: 'assistant', content: stripThink(content) };
    if (calls.length) msg.tool_calls = calls;
    state.history.push(msg);
    if (!calls.length) break;

    for (const call of calls) {
      if (state.stopRequested) {
        state.history.push({ role: 'tool', tool_call_id: call.id, content: 'Cancelled by the user.' });
        continue;
      }
      const row = view.addStep(call);
      setActivity(`${row.doing} ${row.target}`);
      const out = await executeTool(call, row);
      row.done(out);
      state.history.push({ role: 'tool', tool_call_id: call.id, content: out.result });
    }
    if (step === MAX_AGENT_STEPS - 1) addError(`Stopped after ${MAX_AGENT_STEPS} steps. Send a message to let Qwen continue.`);
  }
  setActivity('');
}

function stopChat() {
  state.stopRequested = true;
  if (state.currentChatId) api.chatAbort(state.currentChatId);
  state.pendingApproval?.finish(false);
}

function setBusy(b) {
  state.busy = b;
  if (b) state.stopRequested = false;
  $('#btn-send').classList.toggle('hidden', b);
  $('#btn-stop').classList.toggle('hidden', !b);
  if (!b) setActivity('');
}

function setActivity(text) {
  $('#activity').classList.toggle('hidden', !text);
  $('#activity-text').textContent = text ? `${text}…` : '';
}

function updateCtxMeter() {
  const m = $('#ctx-meter');
  const u = state.lastUsage;
  if (!u) {
    m.classList.add('hidden');
    return;
  }
  const pct = Math.min(100, Math.round((u.promptTokens / u.contextLength) * 100));
  m.classList.remove('hidden');
  m.classList.toggle('warn', pct >= 70 && pct < 95);
  m.classList.toggle('full', pct >= 95);
  m.querySelector('i').style.width = `${pct}%`;
  m.querySelector('.txt').textContent = `${pct}%`;
  m.title = `Context used: ${u.promptTokens.toLocaleString()} of ${u.contextLength.toLocaleString()} tokens. Start a new chat when it gets full.`;
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
  return `<pre data-lang="${escapeHtml(language)}" data-path="${escapeHtml(filePath)}"><code>${escapeHtml(text)}</code></pre>`;
};
// Models often write tags like <tool_call> or <vector> in prose; show them as text instead of
// letting the sanitizer silently delete them.
renderer.html = ({ text }) => escapeHtml(text);
marked.setOptions({ renderer, gfm: true, breaks: false });

function renderMarkdown(node, text) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['style', 'form', 'input'] });
  node.querySelectorAll('pre').forEach(decorateCodeBlock);
}

function decorateCodeBlock(pre) {
  const code = pre.querySelector('code');
  const text = code ? code.textContent : pre.textContent;
  const lang = pre.dataset.lang || '';
  const filePath = pre.dataset.path || '';
  const label = el('span', { class: 'label' });
  if (filePath) label.append(fileBadge(baseName(filePath)), el('span', { text: filePath }));
  else label.textContent = lang || 'code';
  const head = el('div', { class: 'cb-head' }, label,
    el('button', {
      title: 'Copy to clipboard',
      onclick: async (e) => {
        await navigator.clipboard.writeText(text);
        const b = e.currentTarget;
        b.lastChild.textContent = 'Copied';
        setTimeout(() => (b.lastChild.textContent = 'Copy'), 1200);
      }
    }, iconEl('copy'), el('span', { text: 'Copy' })),
    el('button', {
      title: 'Insert at the cursor (or replace the selection) in the open file',
      onclick: () => {
        if (!state.active) return alert('Open a file first.');
        editor.executeEdits('qwen', [{ range: editor.getSelection(), text, forceMoveMarkers: true }]);
        editor.focus();
      }
    }, iconEl('insert'), 'Insert'),
    filePath && state.ws ? el('button', { class: 'apply', title: `Write this code to ${filePath} (shows a diff first)`, onclick: () => applyCodeToFile(normPath(filePath), text) }, iconEl('check'), 'Apply') : null
  );
  const wrap = el('div', { class: 'codeblock' });
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
  const alias = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp', rs: 'rust', yml: 'yaml', md: 'markdown', vue: 'html', golang: 'go', kt: 'kotlin', rb: 'ruby', bat: 'bat', cmd: 'bat' };
  const id = alias[l] || l;
  return monaco.languages.getLanguages().some((x) => x.id === id) ? id : null;
}

async function applyCodeToFile(p, content) {
  const exists = await api.exists(p);
  const original = exists ? findTab(p)?.model.getValue() ?? (await api.read(p)) : null;
  const ok = await new Promise((resolve) => {
    state.pendingApproval = {
      cancelOnClose: true,
      finish: (v) => {
        state.pendingApproval = null;
        closeReview(true);
        resolve(v);
      }
    };
    openReview({ path: p, original: original ?? '', modified: content, pending: true, title: `${exists ? 'Apply changes to' : 'Create'} ${p}` });
  });
  if (!ok) return;
  await api.write(p, content);
  syncOpenTab(p, content);
  recordChange(p, original, content);
  expandTo(p);
  state.fileIndex = null;
  await renderTree();
  await openFile(p);
  highlightChanges(p, original, content);
  flash(`Wrote ${p}`);
}

function addUserMessage(text, attached) {
  const node = el('div', { class: 'msg user' }, text);
  if (attached.length) node.append(el('div', { class: 'attached' }, ...attached.map((a) => el('span', { text: baseName(a), title: a }))));
  $('#messages').append(node);
  scrollChat(true);
}

function addError(text, usedTools) {
  let hint = '';
  if (usedTools && /tool|function/i.test(text)) {
    hint = '\n\nThis model may not support tool calling. Switch to "Chat" below the message box, or pick a tool-capable model such as qwen2.5-coder, qwen3 or qwen3-coder.';
  } else if (/connect|ECONNREFUSED|fetch failed/i.test(text)) {
    hint = `\n\nCheck Settings: is the base URL right and is the server running? For Ollama run "ollama serve" and "ollama pull ${state.settings.model}".`;
  } else if (/401|403|api key|unauthorized/i.test(text)) {
    hint = '\n\nCheck the API key in Settings.';
  }
  $('#messages').append(el('div', { class: 'msg error' }, iconEl('alert'), el('div', { text: text + hint })));
  scrollChat(true);
}

function addAssistantMessage() {
  const think = el('details', { class: 'think hidden' }, el('summary', {}, iconEl('chevronRight'), el('span', { class: 'think-label', text: 'Thinking' })), el('div', { class: 'think-body' }));
  const md = el('div', { class: 'md cursor' });
  const steps = el('div', { class: 'steps' });
  $('#messages').append(el('div', { class: 'msg assistant' }, think, md, steps));
  scrollChat(true);

  let content = '';
  let reasoning = '';
  let pending = false;

  const draw = () => {
    pending = false;
    // Split inline <think> blocks (Qwen3 / QwQ) out of the visible answer.
    let inlineThink = '';
    let visible = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t) => {
      inlineThink += t;
      return '';
    });
    const cut = textToolCallStart(visible);
    if (cut >= 0) visible = visible.slice(0, cut);
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
    finish(hasCalls) {
      draw();
      md.classList.remove('cursor');
      md.classList.toggle('narration', !!hasCalls);
      think.querySelector('.think-label').textContent = 'Thought process';
    },
    addStep(call) {
      return makeStepRow(steps, call);
    }
  };
}

function makeStepRow(container, call) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    /* shown raw below */
  }
  const name = call.function.name;
  const info = TOOL_INFO[name] || { icon: 'sparkles', verb: name, doing: 'Running' };
  const d = describeCall(name, args);
  const body = el('pre');
  const meta = el('span', { class: 'step-meta' });
  const stateEl = el('span', { class: 'step-state' }, el('span', { class: 'spinner' }));
  const verb = el('span', { class: 'step-verb', text: info.verb });
  const target = el('span', { class: `step-target${d.mono ? ' mono' : ''}${d.path ? ' link' : ''}`, text: d.target, title: d.title || d.target });
  const head = el('div', { class: 'step-head' }, iconEl(info.icon), verb, target, meta, stateEl, iconEl('chevronRight', 'chev'));
  const row = el('div', { class: 'step running' }, head, el('div', { class: 'step-body' }, body));
  let onTarget = d.path ? () => openFile(d.path, { preview: true }) : null;
  target.addEventListener('click', (e) => {
    if (onTarget) {
      e.stopPropagation();
      onTarget();
    }
  });
  head.onclick = () => row.classList.toggle('open');
  container.append(row);
  scrollChat();

  return {
    doing: info.doing,
    target: d.target,
    setBody(text) {
      body.textContent = text.length > 8000 ? text.slice(0, 8000) + '\n…' : text;
    },
    setDiffBody(diffText) {
      renderDiffPreview(body, diffText);
    },
    setVerb(v) {
      verb.textContent = v;
    },
    onTarget(fn) {
      onTarget = fn;
      target.classList.add('link');
    },
    done(out) {
      const failed = out.failed || /^Error/.test(out.result) || out.rejected || /^Cancelled/.test(out.result);
      row.classList.remove('running', 'waiting');
      row.classList.add(failed ? 'bad' : 'ok');
      stateEl.innerHTML = icon(failed ? 'x' : 'check');
      if (out.metaHtml) meta.innerHTML = out.metaHtml;
      else meta.textContent = out.rejected ? 'rejected' : /^Error/.test(out.result) ? 'failed' : out.meta || '';
      if (/^Error/.test(out.result)) {
        body.textContent = out.result;
        stateEl.title = out.result;
      }
    },
    requestApproval(opts) {
      row.classList.remove('running');
      row.classList.add('waiting');
      stateEl.innerHTML = icon('alert');
      setActivity('Waiting for your approval');
      return new Promise((resolve) => {
        const bar = el('div', { class: 'step-approval' });
        const finish = (v) => {
          if (state.pendingApproval?.finish === finish) state.pendingApproval = null;
          bar.remove();
          row.classList.remove('waiting');
          row.classList.add('running');
          stateEl.replaceChildren(el('span', { class: 'spinner' }));
          if (state.review?.pending && state.review.path === opts.path) closeReview(true);
          setActivity(v ? 'Working' : '');
          resolve(v);
        };
        state.pendingApproval = { finish };
        if (opts.kind === 'edit') {
          bar.append(
            el('div', { class: 'q' }, el('span', { text: opts.question }), el('span', { class: 'stats', html: statsHtml(opts.stats) })),
            el('div', { class: 'btns' },
              el('button', { class: 'ghost', onclick: () => openReview({ path: opts.path, original: opts.original, modified: opts.modified, pending: true, title: opts.question }) }, iconEl('columns'), 'Review'),
              el('button', { class: 'ghost danger-text', onclick: () => finish(false) }, 'Reject'),
              el('button', { class: 'primary', onclick: () => finish(true) }, iconEl('check'), 'Approve'))
          );
          if (state.settings.followAgent) openReview({ path: opts.path, original: opts.original, modified: opts.modified, pending: true, title: opts.question });
        } else {
          const prefix = commandPrefix(opts.command);
          bar.append(
            el('div', { class: 'q' }, el('span', { text: opts.dangerous ? 'This command could delete or overwrite things. Run it?' : opts.question })),
            el('div', { class: 'cmd', text: opts.command }),
            el('div', { class: 'btns' },
              el('button', { class: 'ghost danger-text', onclick: () => finish(false) }, 'Reject'),
              opts.dangerous ? null : el('button', { class: 'ghost', title: `Run this, and run future "${prefix}" commands without asking`, onclick: async () => { await allowCommandPrefix(prefix); finish(true); } }, `Always allow “${prefix}”`),
              el('button', { class: 'primary', onclick: () => finish(true) }, iconEl('play'), 'Run'))
          );
        }
        row.append(bar);
        scrollChat(true);
        bar.querySelector('button.primary').focus({ preventScroll: true });
      });
    }
  };
}

function renderDiffPreview(pre, diffText) {
  pre.replaceChildren(
    ...diffText.split('\n').slice(0, 400).map((line) =>
      el('div', { class: `diff-line${line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : line.startsWith('@@') ? ' hunk' : ''}`, text: line || ' ' }))
  );
}

function scrollChat(force) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// ===================================================================
// Diffs
// ===================================================================
// Line-based LCS diff with common prefix/suffix trimmed, so big files with small edits stay cheap.
// Returns [op, line, indexInA, indexInB] entries, or null when the changed region is too large.
function diffOps(a, b) {
  const A = a === '' ? [] : a.split(/\r?\n/);
  const B = b === '' ? [] : b.split(/\r?\n/);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  if (a2.length * b2.length > 4_000_000) return null;
  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([' ', A[k], k, k]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) {
      ops.push([' ', a2[i], i + pre, j + pre]);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push(['+', b2[j], i + pre, j + pre]);
      j++;
    } else {
      ops.push(['-', a2[i], i + pre, j + pre]);
      i++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push([' ', A[A.length - suf + k], A.length - suf + k, B.length - suf + k]);
  return ops;
}

function diffStats(a, b) {
  const ops = diffOps(a, b);
  if (!ops) return { added: b.split('\n').length, removed: a.split('\n').length };
  let added = 0;
  let removed = 0;
  for (const [op] of ops) {
    if (op === '+') added++;
    else if (op === '-') removed++;
  }
  return { added, removed };
}

function unifiedDiff(a, b, context = 3) {
  const ops = diffOps(a, b);
  if (!ops) return '(change too large for an inline preview — use Review)';
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
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
    out.push(`@@ line ${ops[start][3] + 1} @@`);
    for (let x = start; x < end; x++) out.push(ops[x][0] + ops[x][1]);
    k = end;
  }
  return out.join('\n') || '(no changes)';
}

// ===================================================================
// Terminal
// ===================================================================
function showTerminal(show, focus = true) {
  $('#terminal').classList.toggle('hidden', !show);
  $('#act-terminal').classList.toggle('active', show);
  if (show && focus) $('#term-in').focus();
  saveLayout();
}
function termWrite(text, cls) {
  const out = $('#term-out');
  out.append(el('span', { class: cls, text }));
  out.scrollTop = out.scrollHeight;
}
api.onCommandOutput((t) => termWrite(t));

async function runTerminalCommand(cmd) {
  if (!requireWorkspace()) return;
  termWrite(`\n❯ ${cmd}\n`, 'term-cmd');
  $('#term-in').disabled = true;
  const r = await api.runCommand(cmd, 10 * 60_000);
  termWrite(`[exit code ${r.code}]\n`, 'term-exit');
  $('#term-in').disabled = false;
  $('#term-in').focus();
  state.fileIndex = null;
  renderTree();
}

// ===================================================================
// Go to file (Ctrl+P) / attach file
// ===================================================================
async function openQuick(mode = 'open') {
  if (!requireWorkspace()) return;
  state.quick = { mode, items: [], sel: 0 };
  const input = $('#quick-input');
  input.value = '';
  input.placeholder = mode === 'attach' ? 'Attach a file to your next message…' : 'Go to file…';
  $('#quick-modal').classList.remove('hidden');
  input.focus();
  if (!state.fileIndex) {
    $('#quick-list').replaceChildren(el('div', { class: 'quick-empty', text: 'Indexing files…' }));
    const r = await api.listRecursive('.', 20000, 20);
    state.fileIndex = r.files.filter((f) => !f.endsWith('/'));
  }
  renderQuick();
}

function fuzzyScore(path, q) {
  if (!q) return 1;
  const lower = path.toLowerCase();
  const name = baseName(lower);
  if (name.includes(q)) return 1000 - name.length + (name.startsWith(q) ? 200 : 0);
  if (lower.includes(q)) return 500 - lower.length / 10;
  let pi = 0;
  let score = 0;
  for (const ch of q) {
    const found = lower.indexOf(ch, pi);
    if (found < 0) return -1;
    score += found === pi ? 3 : 1;
    pi = found + 1;
  }
  return score;
}

function renderQuick() {
  const q = $('#quick-input').value.trim().toLowerCase().replace(/\\/g, '/');
  const items = (state.fileIndex || [])
    .map((p) => [p, fuzzyScore(p, q)])
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([p]) => p);
  state.quick.items = items;
  state.quick.sel = Math.min(state.quick.sel, Math.max(0, items.length - 1));
  const list = $('#quick-list');
  if (!items.length) {
    list.replaceChildren(el('div', { class: 'quick-empty', text: 'No matching files.' }));
    return;
  }
  list.replaceChildren(...items.map((p, i) =>
    el('div', { class: `qi${i === state.quick.sel ? ' sel' : ''}`, onmousedown: (e) => { e.preventDefault(); chooseQuick(i); } },
      fileBadge(baseName(p)), el('span', { class: 'name', text: baseName(p) }), el('span', { class: 'dir', text: parentDir(p) === '.' ? '' : parentDir(p) }))));
  list.querySelector('.qi.sel')?.scrollIntoView({ block: 'nearest' });
}

function chooseQuick(i) {
  const p = state.quick.items[i];
  closeQuick();
  if (!p) return;
  if (state.quick.mode === 'attach') addFileToChat(p);
  else openFile(p);
}

function closeQuick() {
  $('#quick-modal').classList.add('hidden');
}

// ===================================================================
// Settings & status bar
// ===================================================================
function applySettingsToUi() {
  const s = state.settings;
  $('#model-name').textContent = s.model || 'no model';
  editor?.updateOptions({ fontSize: Number(s.fontSize) || 14 });
  reviewEditor?.updateOptions({ fontSize: Number(s.fontSize) || 14 });
  $$('#mode-seg button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'agent') === !!s.agentMode));
  const mode = approvalMode();
  const btn = $('#btn-approval');
  btn.className = `mode-btn ${mode}`;
  btn.firstElementChild.innerHTML = icon(APPROVAL_MODES[mode].icon);
  $('#approval-label').textContent = APPROVAL_MODES[mode].label;
  btn.title = `Approvals: ${APPROVAL_MODES[mode].desc}`;
  btn.classList.toggle('hidden', !s.agentMode);
  renderStatusbar();
}

function renderStatusbar() {
  $('#folder-name').textContent = state.ws ? state.ws.name : 'Open a folder';
  $('#sb-folder-name').textContent = state.ws ? state.ws.root : 'No folder';
  $('#sb-follow').classList.toggle('on', !!state.settings?.followAgent);
  $('#sb-follow').title = state.settings?.followAgent
    ? 'Follow Qwen is on: the editor opens files as Qwen reads and edits them. Click to turn off.'
    : 'Follow Qwen is off. Click to open files in the editor as Qwen reads and edits them.';
}

function renderCursor() {
  const model = editor?.getModel();
  if (!model || !state.active) {
    $('#sb-cursor').textContent = '';
    $('#sb-lang').textContent = '';
    return;
  }
  const pos = editor.getPosition();
  $('#sb-cursor').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : '';
  const lang = monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId());
  $('#sb-lang').textContent = lang?.aliases?.[0] || model.getLanguageId();
}

let flashTimer = null;
function flash(text) {
  $('#sb-status').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($('#sb-status').textContent = ''), 3500);
}

function showApprovalMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const current = approvalMode();
  const items = Object.entries(APPROVAL_MODES).map(([key, m]) => ({
    label: m.label,
    desc: m.desc,
    icon: m.icon,
    checked: key === current,
    onClick: async () => {
      state.settings = await api.setSettings({ approvalMode: key });
      applySettingsToUi();
      flash(`Approvals: ${m.label}`);
    }
  }));
  showMenu(r.left, r.top, items, { above: true });
}

function showAttachMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.top, [
    { label: 'Attach a file…', icon: 'search', detail: 'Ctrl+Shift+A', onClick: () => openQuick('attach') },
    state.active ? { label: `Attach open file (${baseName(state.active)})`, icon: 'paperclip', checked: state.attachCurrent, onClick: () => { state.attachCurrent = !state.attachCurrent; renderChips(); } } : null
  ].filter(Boolean), { above: true });
}

function openSettings() {
  const s = state.settings;
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'temperature', 'fontSize', 'contextLength']) $(`#s-${k}`).value = s[k] ?? '';
  for (const k of ['agentMode', 'includeCurrentFile', 'followAgent', 'autoCheckUpdates']) $(`#s-${k}`).checked = !!s[k];
  $('#about-version').textContent = state.appInfo?.version || '';
  $('#about-kind').textContent = KIND_TEXT[state.appInfo?.kind] || '';
  renderUpdateUi();
  $('#s-approvalMode').value = approvalMode();
  $('#s-allowedCommands').value = (s.allowedCommands || []).join(', ');
  $('#s-test-result').textContent = '';
  $('#settings-modal').classList.remove('hidden');
}

async function saveSettingsFromUi() {
  const patch = {};
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'approvalMode']) patch[k] = $(`#s-${k}`).value.trim();
  patch.temperature = parseFloat($('#s-temperature').value) || 0;
  patch.fontSize = parseInt($('#s-fontSize').value, 10) || 14;
  patch.contextLength = Math.max(2048, parseInt($('#s-contextLength').value, 10) || 32768);
  patch.allowedCommands = $('#s-allowedCommands').value.split(',').map((x) => x.trim()).filter(Boolean);
  for (const k of ['agentMode', 'includeCurrentFile', 'followAgent', 'autoCheckUpdates']) patch[k] = $(`#s-${k}`).checked;
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
  await api.setSettings({ baseUrl: $('#s-baseUrl').value.trim(), apiKey: $('#s-apiKey').value.trim(), provider: $('#s-provider').value });
  try {
    const models = await api.listModels();
    $('#model-list').replaceChildren(...models.map((m) => el('option', { value: m })));
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
  const ollama = state.settings.provider === 'ollama';
  try {
    const models = await api.listModels();
    const found = models.includes(state.settings.model);
    dot.className = `dot ${found || !models.length ? 'ok' : 'bad'}`;
    $('#btn-model').title = found || !models.length ? `Connected to ${state.settings.baseUrl}` : `Model "${state.settings.model}" not found on the server. Click to choose another.`;
    if (found) $('#toasts .toast[data-key="model"]')?.remove();
    if (ollama && !found) warnOnce(`missing:${state.settings.model}`, () => {
      const known = MODEL_CATALOG.find((m) => m.id === state.settings.model);
      toast({
        key: 'model',
        icon: 'download',
        text: [el('b', { text: `${state.settings.model} isn't downloaded yet.` }), models.length ? ' Download it, or pick one of your installed models from the model menu.' : ' Download it, or let the app suggest a model that suits this PC.'],
        actions: [
          { label: 'Suggest a model', onClick: openModels },
          { label: `Download${known ? ` (${formatGB(known.sizeGB)})` : ''}`, primary: true, onClick: () => downloadModel(known || { id: state.settings.model, name: state.settings.model }) }
        ]
      });
    });
  } catch (e) {
    dot.className = 'dot bad';
    $('#btn-model').title = `Not connected: ${e.message}`;
    if (ollama) warnOnce('ollama-down', () =>
      toast({
        key: 'model',
        icon: 'alert',
        text: [el('b', { text: "Can't reach Ollama." }), ' Qwen runs on this PC through Ollama. Install it, or start it if it is already installed.'],
        actions: [
          { label: 'Retry', onClick: checkConnection },
          { label: 'Get Ollama', primary: true, onClick: () => api.openExternal('https://ollama.com/download') }
        ]
      }));
  }
}

function warnOnce(key, fn) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  fn();
}

// ===================================================================
// Toasts
// ===================================================================
// text: string, node, or an array of them. Each action closes the toast unless `keep` is set.
function toast({ text, icon: ic = 'info', actions = [], timeout = 0, key }) {
  if (key) $(`#toasts .toast[data-key="${key}"]`)?.remove();
  const node = el('div', { class: 'toast', dataset: key ? { key } : {} });
  const close = () => node.remove();
  node.append(
    el('div', { class: 't-main' }, iconEl(ic), el('div', { class: 't-text' }, text), el('button', { class: 'icon-btn t-close', title: 'Dismiss', onclick: close }, iconEl('x'))),
    actions.length
      ? el('div', { class: 't-actions' }, ...actions.map((a) =>
        el('button', { class: a.primary ? 'primary' : 'ghost', onclick: () => { if (!a.keep) close(); a.onClick?.(); } }, a.label)))
      : null
  );
  $('#toasts').append(node);
  if (timeout) setTimeout(close, timeout);
  return { close };
}

// ===================================================================
// Updates
// ===================================================================
const KIND_TEXT = {
  installer: 'Installed version: updates download and install inside the app.',
  portable: 'Portable version: updates open the download page.',
  zip: 'Zip version: updates open the download page.',
  dev: 'Running from source: update with git pull.'
};

async function initUpdates() {
  state.appInfo = await api.appInfo();
  api.onUpdateProgress((p) => {
    state.update.percent = p.percent || 0;
    renderUpdateUi();
  });
  if (state.settings.autoCheckUpdates && state.appInfo.kind !== 'dev') {
    setTimeout(() => checkUpdates(false), 6000);
    setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);
  }
}

async function checkUpdates(manual) {
  if (['checking', 'downloading', 'ready'].includes(state.update.phase)) return;
  state.update.phase = 'checking';
  renderUpdateUi();
  try {
    const info = await api.checkForUpdate();
    state.update.info = info;
    state.update.phase = info.available ? 'available' : 'current';
    if (info.available && !manual) warnOnce(`update:${info.latest}`, showUpdateToast);
  } catch (e) {
    state.update.phase = 'error';
    state.update.error = cleanError(e);
  }
  renderUpdateUi();
}

function showUpdateToast() {
  const info = state.update.info;
  toast({
    key: 'update',
    icon: 'download',
    text: [el('b', { text: `Qwen Workspace ${info.latest} is available.` }), ` You have ${info.current}.`],
    actions: [
      { label: "What's new", keep: true, onClick: () => api.openExternal(info.url) },
      { label: 'Later' },
      { label: info.canInstall ? 'Update now' : 'Download', primary: true, onClick: startUpdate }
    ]
  });
}

async function startUpdate() {
  const info = state.update.info;
  if (!info?.available) return;
  if (!info.canInstall) {
    await api.downloadUpdate();
    flash('Opened the download page');
    return;
  }
  state.update.phase = 'downloading';
  state.update.percent = 0;
  renderUpdateUi();
  try {
    await api.downloadUpdate();
    state.update.phase = 'ready';
    renderUpdateUi();
    toast({
      key: 'update',
      icon: 'download',
      text: [el('b', { text: `Update ${info.latest} is ready.` }), ' Restart to finish, or it installs when you close the app.'],
      actions: [{ label: 'Later' }, { label: 'Restart now', primary: true, onClick: () => api.installUpdate() }]
    });
  } catch (e) {
    state.update.phase = 'available';
    renderUpdateUi();
    toast({
      key: 'update',
      icon: 'alert',
      text: `The update couldn't be downloaded: ${cleanError(e)}`,
      actions: [{ label: 'Open download page', primary: true, onClick: () => api.openExternal(info.url) }]
    });
  }
}

function onUpdateButton() {
  const u = state.update;
  if (u.phase === 'available') startUpdate();
  else if (u.phase === 'ready') api.installUpdate();
  else checkUpdates(true);
}

function renderUpdateUi() {
  const u = state.update;
  const pct = Math.round(u.percent || 0);
  $('#sb-update').classList.toggle('hidden', !['available', 'downloading', 'ready'].includes(u.phase));
  $('#sb-update-text').textContent =
    u.phase === 'available' ? `Update ${u.info.latest} available` : u.phase === 'downloading' ? `Downloading update ${pct}%` : u.phase === 'ready' ? 'Restart to update' : '';
  const st = $('#update-status');
  st.className = `hint${u.phase === 'error' ? ' bad' : u.phase === 'current' ? ' ok' : ''}`;
  st.textContent = {
    checking: 'Checking…',
    current: `You're on the latest version${u.info?.latest ? ` (${u.info.latest})` : ''}.`,
    available: `Version ${u.info?.latest} is available.`,
    downloading: `Downloading… ${pct}%`,
    ready: 'Update downloaded. Restart to install it.',
    error: `Couldn't check for updates: ${u.error}`
  }[u.phase] || '';
  const btn = $('#btn-check-updates');
  btn.lastChild.textContent =
    u.phase === 'available' ? (u.info.canInstall ? 'Update now' : 'Download update') : u.phase === 'ready' ? 'Restart now' : 'Check for updates';
  btn.disabled = u.phase === 'checking' || u.phase === 'downloading';
}

function cleanError(e) {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ===================================================================
// Models for this PC
// ===================================================================
async function showModelMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  let models = [];
  try {
    models = await api.listModels();
  } catch {
    /* server not reachable */
  }
  const items = models.slice(0, 14).map((id) => ({
    label: id,
    checked: id === state.settings.model,
    onClick: async () => {
      state.settings = await api.setSettings({ model: id });
      applySettingsToUi();
      checkConnection();
      flash(`Model: ${id}`);
    }
  }));
  if (items.length) items.push('-');
  items.push({ label: 'Models for this PC…', icon: 'cpu', onClick: openModels });
  items.push({ label: 'Model settings…', icon: 'settings', onClick: openSettings });
  showMenu(r.right - 240, r.bottom + 4, items);
}

async function openModels() {
  $('#settings-modal').classList.add('hidden');
  $('#models-modal').classList.remove('hidden');
  if (!state.specs) $('#m-list').replaceChildren(el('div', { class: 'quick-empty', text: 'Checking this PC…' }));
  const [specs, tags] = await Promise.all([api.systemSpecs(), api.ollamaTags()]);
  state.specs = specs;
  state.tags = tags;
  renderModels();
}

function installedNames() {
  return new Set((state.tags?.models || []).map((m) => m.name));
}

function renderModels() {
  const specs = state.specs;
  if (!specs) return;
  const tags = state.tags || { running: false };
  const [gpuText, ramText, cpuText] = describeSpecs(specs);
  $('#m-specs').replaceChildren(
    el('span', { class: `spec-chip${specs.gpu ? ' gpu' : ' warn'}`, title: specs.gpus.map((g) => `${g.name}: ${formatGB(g.vramGB)}`).join('\n') || 'No GPU detected' }, iconEl('cpu'), gpuText),
    el('span', { class: 'spec-chip' }, ramText),
    el('span', { class: 'spec-chip', title: specs.cpu }, cpuText),
    el('button', { class: 'icon-btn', title: 'Scan again', onclick: async () => { state.specs = await api.systemSpecs(true); state.tags = await api.ollamaTags(); renderModels(); } }, iconEl('refresh'))
  );

  const usingOllama = state.settings.provider === 'ollama';
  let notice;
  if (!tags.running) {
    notice = el('div', { class: 'notice warn' }, iconEl('alert'),
      el('span', { class: 'grow', text: "Ollama isn't running. It downloads and runs these models on this PC. Install it (or start it), then refresh." }),
      el('button', { class: 'ghost', onclick: async () => { state.tags = await api.ollamaTags(); renderModels(); } }, iconEl('refresh'), 'Refresh'),
      el('button', { class: 'primary', onclick: () => api.openExternal('https://ollama.com/download') }, 'Get Ollama'));
  } else if (!usingOllama) {
    notice = el('div', { class: 'notice' }, iconEl('info'),
      el('span', { class: 'grow', text: 'You are using a different provider. Choosing a model here switches the app to Ollama on this PC.' }));
  } else {
    const n = tags.models.length;
    notice = el('div', { class: 'notice ok' }, iconEl('check'),
      el('span', { class: 'grow', text: `Ollama is running with ${n} model${n === 1 ? '' : 's'} downloaded.` }));
  }
  const notices = [notice];
  if (!specs.gpu) {
    notices.push(el('div', { class: 'notice' }, iconEl('info'),
      el('span', { class: 'grow', text: 'Without a supported GPU, local models run on the CPU and respond slowly. For faster answers, use Qwen through a cloud provider (DashScope or OpenRouter) in Settings.' }),
      el('button', { class: 'ghost', onclick: openSettings }, 'Open Settings')));
  }
  $('#m-ollama').replaceChildren(...notices);

  const { models, recommended, stronger } = recommendModels(specs);
  const fitOrder = { gpu: 3, mixed: 2, cpu: 1, none: 0 };
  const sorted = [...models].sort((a, b) => {
    const pri = (m) => (m.id === recommended?.id ? 2 : m.id === stronger?.id ? 1 : 0);
    return pri(b) - pri(a) || fitOrder[b.fit] - fitOrder[a.fit] || b.rank - a.rank;
  });
  $('#m-list').replaceChildren(...sorted.map((m) => modelRow(m, m.id === recommended?.id, m.id === stronger?.id)));
}

const FIT_TEXT = {
  gpu: 'Fast · fits in GPU memory',
  mixed: 'Usable · partly on CPU',
  cpu: 'Slow · mostly on CPU',
  none: 'Too large for this PC'
};

function modelRow(m, isRec, isStrong) {
  const installed = installedNames().has(m.id);
  const inUse = installed && state.settings.provider === 'ollama' && state.settings.model === m.id;
  const row = el('div', { class: `m-row${isRec ? ' rec' : ''}${m.fit === 'none' ? ' none' : ''}`, dataset: { model: m.id } },
    el('div', { class: 'm-title' },
      el('span', { class: 'name', text: m.name }),
      el('span', { class: 'id', text: m.id }),
      isRec ? el('span', { class: 'tagb rec', text: 'Recommended' }) : null,
      isStrong ? el('span', { class: 'tagb strong', text: 'Most capable that runs' }) : null,
      inUse ? el('span', { class: 'tagb use', text: 'In use' }) : installed ? el('span', { class: 'tagb inst', text: 'Downloaded' }) : null),
    el('div', { class: 'm-facts' },
      el('span', { class: `fit ${m.fit}`, text: FIT_TEXT[m.fit] }),
      el('span', { text: `${formatGB(m.sizeGB)} download` }),
      el('span', { text: `${formatContext(m.ctx)} context`, title: `Needs about ${formatGB(m.needGB)} of memory at this context size` }),
      el('span', { text: `Agent: ${m.agent}` })),
    el('div', { class: 'm-note', text: m.note }),
    el('div', { class: 'm-act' }));
  renderModelAction(row, m, installed, inUse, isRec || isStrong);
  return row;
}

function renderModelAction(row, m, installed, inUse, highlight) {
  const act = row.querySelector('.m-act');
  const pull = state.pulls.get(m.id);
  if (pull) {
    const pct = pull.total ? Math.round((pull.completed / pull.total) * 100) : 0;
    act.replaceChildren(
      el('div', { class: 'progress' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'ptext', text: pullText(pull) }),
      el('button', { class: 'ghost', onclick: () => api.ollamaPullCancel(m.id) }, 'Cancel'));
  } else if (inUse) {
    act.replaceChildren(el('button', { class: 'ghost', disabled: true }, iconEl('check'), 'In use'));
  } else if (installed) {
    act.replaceChildren(el('button', { class: 'primary', onclick: () => useModel(m) }, 'Use'));
  } else {
    act.replaceChildren(el('button', {
      class: highlight ? 'primary' : 'ghost',
      disabled: !state.tags?.running,
      title: state.tags?.running ? `Download ${m.id} with Ollama` : 'Start Ollama first',
      onclick: () => downloadModel(m)
    }, iconEl('download'), `Download ${formatGB(m.sizeGB)}`));
  }
}

function pullText(p) {
  if (p.status === 'downloading' || (p.total && /^pulling [0-9a-f]/.test(p.status))) {
    return `${formatGB((p.completed || 0) / 1e9)} of ${formatGB((p.total || 0) / 1e9)}`;
  }
  return (p.status || 'Starting').replace(/^\w/, (c) => c.toUpperCase());
}

api.onPullProgress((p) => {
  const cur = state.pulls.get(p.model);
  if (!cur) return;
  Object.assign(cur, p);
  const row = $(`#m-list .m-row[data-model="${CSS.escape(p.model)}"]`);
  if (!row) return;
  const pct = cur.total ? Math.round((cur.completed / cur.total) * 100) : 0;
  const bar = row.querySelector('.progress i');
  if (bar) {
    bar.style.width = `${pct}%`;
    row.querySelector('.ptext').textContent = pullText(cur);
  }
});

async function downloadModel(m) {
  if (state.pulls.has(m.id)) return;
  state.pulls.set(m.id, { status: 'starting', completed: 0, total: 0 });
  if (!$('#models-modal').classList.contains('hidden')) renderModels();
  flash(`Downloading ${m.id}…`);
  const res = await api.ollamaPull(m.id);
  state.pulls.delete(m.id);
  state.tags = await api.ollamaTags();
  if (res.ok) {
    const entry = state.specs ? recommendModels(state.specs).models.find((x) => x.id === m.id) : null;
    const target = entry || m;
    toast({
      key: `pull-${m.id}`,
      icon: 'check',
      text: [el('b', { text: m.name || m.id }), ' is downloaded.'],
      actions: state.settings.model === m.id && state.settings.provider === 'ollama' ? [] : [{ label: 'Use it', primary: true, onClick: () => useModel(target) }],
      timeout: 20000
    });
    checkConnection();
  } else if (!res.cancelled) {
    toast({ key: `pull-${m.id}`, icon: 'alert', text: `Downloading ${m.id} failed: ${res.error}` });
  }
  if (!$('#models-modal').classList.contains('hidden')) renderModels();
}

async function useModel(m) {
  const base = state.tags?.base || 'http://localhost:11434';
  const patch = { provider: 'ollama', baseUrl: `${base}/v1`, model: m.id };
  if (m.ctx) patch.contextLength = m.ctx;
  state.settings = await api.setSettings(patch);
  applySettingsToUi();
  checkConnection();
  if (!$('#models-modal').classList.contains('hidden')) renderModels();
  flash(`Using ${m.id}${m.ctx ? ` · ${formatContext(m.ctx)} context` : ''}`);
}

// ===================================================================
// Menus, prompts, layout
// ===================================================================
function showMenu(x, y, items, { above } = {}) {
  const menu = $('#ctx-menu');
  menu.replaceChildren(...items.map((it) => {
    if (it === '-') return el('div', { class: 'sep' });
    return el('div', {
      class: `mi${it.checked ? ' checked' : ''}${it.desc ? ' tall' : ''}`,
      title: it.detail || '',
      onclick: () => {
        menu.classList.add('hidden');
        it.onClick();
      }
    },
    it.icon ? iconEl(it.icon) : null,
    it.desc ? el('span', {}, el('span', { text: it.label }), el('span', { class: 'desc', text: it.desc })) : el('span', { text: it.label }),
    it.detail && !it.desc ? el('span', { class: 'detail', text: it.detail }) : null);
  }));
  menu.classList.remove('hidden');
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 6))}px`;
  menu.style.top = `${Math.max(4, above ? y - h - 6 : Math.min(y, innerHeight - h - 6))}px`;
}

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
  $$('.splitter').forEach((sp) => {
    sp.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = $('#' + sp.dataset.target);
      const horizontal = sp.classList.contains('h');
      const start = horizontal ? e.clientY : e.clientX;
      const startSize = horizontal ? target.offsetHeight : target.offsetWidth;
      sp.classList.add('dragging');
      document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
      const move = (ev) => {
        const delta = (horizontal ? ev.clientY : ev.clientX) - start;
        if (horizontal) target.style.height = `${Math.max(90, startSize - delta)}px`;
        else target.style.width = `${Math.max(170, sp.dataset.side === 'right' ? startSize - delta : startSize + delta)}px`;
      };
      const up = () => {
        sp.classList.remove('dragging');
        document.body.style.cursor = '';
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        saveLayout();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  });
}

// Panel sizes are a per-machine convenience, so localStorage is fine (and optional).
function saveLayout() {
  try {
    localStorage.setItem('qw.layout', JSON.stringify({
      side: $('#sidepanel').style.width,
      chat: $('#chat').style.width,
      term: $('#terminal').style.height,
      sideHidden: $('#sidepanel').classList.contains('hidden'),
      view: state.view
    }));
  } catch {
    /* storage unavailable */
  }
}
function restoreLayout() {
  let l = null;
  try {
    l = JSON.parse(localStorage.getItem('qw.layout') || 'null');
  } catch {
    /* ignore */
  }
  if (!l) return;
  if (l.side) $('#sidepanel').style.width = l.side;
  if (l.chat) $('#chat').style.width = l.chat;
  if (l.term) $('#terminal').style.height = l.term;
  if (l.view) showView(l.view);
  if (l.sideHidden) {
    $('#sidepanel').classList.add('hidden');
    $$('.act[data-view]').forEach((b) => b.classList.remove('active'));
  }
}

function autoGrow() {
  const t = $('#prompt');
  t.style.height = 'auto';
  t.style.height = `${Math.min(260, t.scrollHeight)}px`;
}

function bindUi() {
  $('#btn-folder').onclick = (e) => showFolderMenu(e.currentTarget);
  $('#sb-folder').onclick = (e) => showFolderMenu(e.currentTarget);
  $('#btn-quick').onclick = () => openQuick('open');
  $('#btn-settings').onclick = openSettings;
  $('#act-settings').onclick = openSettings;
  $('#btn-model').onclick = (e) => showModelMenu(e.currentTarget);
  $('#s-find-models').onclick = openModels;
  $('#m-close').onclick = () => $('#models-modal').classList.add('hidden');
  $('#models-modal').onmousedown = (e) => {
    if (e.target.id === 'models-modal') $('#models-modal').classList.add('hidden');
  };
  $('#btn-check-updates').onclick = onUpdateButton;
  $('#sb-update').onclick = onUpdateButton;
  $$('.act[data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view, true)));
  $('#act-terminal').onclick = () => showTerminal($('#terminal').classList.contains('hidden'));
  $('#sb-terminal').onclick = () => showTerminal($('#terminal').classList.contains('hidden'));
  $('#sb-follow').onclick = async () => {
    state.settings = await api.setSettings({ followAgent: !state.settings.followAgent });
    renderStatusbar();
    flash(`Follow Qwen ${state.settings.followAgent ? 'on' : 'off'}`);
  };

  $('#btn-new-file').onclick = () => newFile();
  $('#btn-new-folder').onclick = () => newFolder();
  $('#btn-refresh').onclick = () => {
    state.fileIndex = null;
    renderTree();
  };
  $('#btn-collapse').onclick = () => {
    state.expanded = new Set(['.']);
    renderTree();
  };
  $('#btn-revert-all').onclick = revertAll;

  $('#search-input').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  };
  $('#search-input').onkeydown = (e) => {
    if (e.key === 'Enter') runSearch();
  };
  $('#search-regex').onclick = (e) => {
    state.searchRegex = !state.searchRegex;
    e.currentTarget.classList.toggle('on', state.searchRegex);
    runSearch();
  };

  $('#review-layout').onclick = () => {
    reviewSideBySide = !reviewSideBySide;
    reviewEditor?.updateOptions({ renderSideBySide: reviewSideBySide });
    $('#review-layout').innerHTML = icon(reviewSideBySide ? 'columns' : 'rows');
  };

  $('#btn-term-close').onclick = () => showTerminal(false);
  $('#btn-term-clear').onclick = () => $('#term-out').replaceChildren();
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
  $('#btn-attach').onclick = (e) => showAttachMenu(e.currentTarget);
  $('#btn-approval').onclick = (e) => showApprovalMenu(e.currentTarget);
  $$('#mode-seg button').forEach((b) => {
    b.onclick = async () => {
      state.settings = await api.setSettings({ agentMode: b.dataset.mode === 'agent' });
      applySettingsToUi();
    };
  });
  $('#prompt').oninput = autoGrow;
  $('#prompt').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  $('#s-provider').onchange = (e) => {
    const p = PROVIDERS[e.target.value];
    if (p.baseUrl) $('#s-baseUrl').value = p.baseUrl;
    if (p.model) $('#s-model').value = p.model;
  };
  $('#s-fetch-models').onclick = fetchModels;
  $('#s-save').onclick = saveSettingsFromUi;
  $('#s-cancel').onclick = () => $('#settings-modal').classList.add('hidden');
  $('#s-close').onclick = () => $('#settings-modal').classList.add('hidden');

  $('#quick-input').oninput = () => {
    state.quick.sel = 0;
    renderQuick();
  };
  $('#quick-input').onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.quick.items.length;
      if (n) state.quick.sel = (state.quick.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderQuick();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseQuick(state.quick.sel);
    } else if (e.key === 'Escape') {
      closeQuick();
    }
  };
  $('#quick-modal').onmousedown = (e) => {
    if (e.target.id === 'quick-modal') closeQuick();
  };

  $('#input-form').onsubmit = (e) => {
    e.preventDefault();
    closeInput($('#input-value').value.trim());
  };
  $('#input-cancel').onclick = () => closeInput(null);

  addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctx-menu')) $('#ctx-menu').classList.add('hidden');
  });
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      $('#ctx-menu').classList.add('hidden');
      if (!$('#settings-modal').classList.contains('hidden')) $('#settings-modal').classList.add('hidden');
      if (!$('#models-modal').classList.contains('hidden')) $('#models-modal').classList.add('hidden');
      if (!$('#input-modal').classList.contains('hidden')) closeInput(null);
      if (!$('#quick-modal').classList.contains('hidden')) closeQuick();
      return;
    }
    if (!mod) return;
    if (key === 'o') {
      e.preventDefault();
      pickWorkspace();
    } else if (key === 'p') {
      e.preventDefault();
      openQuick('open');
    } else if (key === 's' && !e.shiftKey) {
      e.preventDefault();
      saveActive();
    } else if (e.key === '`') {
      e.preventDefault();
      showTerminal($('#terminal').classList.contains('hidden'));
    } else if (key === 'l') {
      e.preventDefault();
      $('#prompt').focus();
    } else if (key === 'b') {
      e.preventDefault();
      showView(state.view, true);
    } else if (key === 'f' && e.shiftKey) {
      e.preventDefault();
      showView('search');
    } else if (key === 'e' && e.shiftKey) {
      e.preventDefault();
      showView('explorer');
    } else if (key === 'a' && e.shiftKey) {
      e.preventDefault();
      openQuick('attach');
    } else if (key === 'w') {
      e.preventDefault();
      if (state.review?.visible) closeReview();
      else if (state.active) closeTab(state.active);
    }
  });
  addEventListener('beforeunload', (e) => {
    if (state.tabs.some(isDirty)) e.returnValue = false;
  });
}

// ===================================================================
// Helpers
// ===================================================================
function baseName(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}
function parentDir(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}
function joinPath(dir, name) {
  return dir === '.' || !dir ? name : `${dir}/${name}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
