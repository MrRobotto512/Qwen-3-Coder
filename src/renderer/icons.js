'use strict';

// Line icons (24×24, stroke-based) used throughout the UI.
const ICONS = {
  files: '<path d="M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z"/><path d="M15 2v5h5"/><path d="M4 7v13a2 2 0 0 0 2 2h9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  changes: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V15a3 3 0 0 0 3 3h6.5"/><path d="m13 15.5 2.5 2.5-2.5 2.5"/><path d="M18 15.5V9a3 3 0 0 0-3-3H8.5"/><path d="M11 3.5 8.5 6 11 8.5"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 17l2.4-6.2A2 2 0 0 1 7.3 9.5H21l-2.6 7.2a2 2 0 0 1-1.9 1.3H5a2 2 0 0 1-2-1z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  collapse: '<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  paperclip: '<path d="m20.5 11.5-8.4 8.4a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.4 3.4 0 0 1 4.9 4.9l-8.4 8.4a1.7 1.7 0 0 1-2.5-2.5l7.8-7.7"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/><path d="m14.5 5.5 3 3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".9" fill="currentColor"/><circle cx="4.5" cy="12" r=".9" fill="currentColor"/><circle cx="4.5" cy="18" r=".9" fill="currentColor"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  external: '<path d="M14 4h6v6M10 14 20 4M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  sparkles: '<path d="M11 3.5 12.8 8.2 17.5 10l-4.7 1.8L11 16.5l-1.8-4.7L4.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  alert: '<path d="M12 9v4M12 16.5v.01"/><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  crosshair: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  bug: '<rect x="7.5" y="7" width="9" height="13" rx="4.5"/><path d="M12 11v9M4 13h3.5M16.5 13H20M5 7.5 7.5 9.5M19 7.5l-2.5 2M5 19.5l2.6-2M19 19.5l-2.6-2M9.5 4.5 10.5 7M14.5 4.5 13.5 7"/>',
  wand: '<path d="m4 20 11-11M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3M18 3l.01.01"/><path d="m13 8 3 3"/>',
  chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  insert: '<path d="M12 4v10M8 10l4 4 4-4M5 20h14"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/>',
  shieldCheck: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  zap: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4.5h4.5M12 8v4.5l3 2"/>'
};

function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function iconEl(name, cls = '') {
  const span = document.createElement('span');
  span.className = `ico ${cls}`.trim();
  span.innerHTML = icon(name);
  return span;
}

// Small colored badges for file types, in place of emoji.
const FILE_TYPES = {
  js: ['JS', '#e8d44d'], mjs: ['JS', '#e8d44d'], cjs: ['JS', '#e8d44d'], jsx: ['JSX', '#61dafb'],
  ts: ['TS', '#3b8eea'], tsx: ['TSX', '#61dafb'], py: ['PY', '#4b8bbe'], ipynb: ['NB', '#f37626'],
  c: ['C', '#7aa2f7'], h: ['H', '#9aa5ce'], cpp: ['C++', '#f34b7d'], cc: ['C++', '#f34b7d'], cxx: ['C++', '#f34b7d'],
  hpp: ['H++', '#f78cac'], hh: ['H++', '#f78cac'], cs: ['C#', '#68b723'], java: ['JV', '#e76f00'], kt: ['KT', '#a97bff'],
  go: ['GO', '#00add8'], rs: ['RS', '#dea584'], rb: ['RB', '#cc342d'], php: ['PHP', '#8892bf'], swift: ['SW', '#f05138'],
  lua: ['LUA', '#6c78f0'], json: ['{}', '#cbcb41'], md: ['MD', '#519aba'], txt: ['TXT', '#8b8b96'],
  html: ['<>', '#e5704a'], htm: ['<>', '#e5704a'], css: ['#', '#6d8fd8'], scss: ['#', '#cd6799'],
  sh: ['$', '#89e051'], bash: ['$', '#89e051'], bat: ['$', '#89e051'], cmd: ['$', '#89e051'], ps1: ['PS', '#5391fe'],
  yml: ['YML', '#cb4b5c'], yaml: ['YML', '#cb4b5c'], toml: ['TOML', '#9c4221'], ini: ['INI', '#8b8b96'], cfg: ['CFG', '#8b8b96'],
  xml: ['XML', '#e5704a'], sql: ['SQL', '#e38c00'], cmake: ['CM', '#64c4b4'], mk: ['MK', '#6d8086'], exe: ['EXE', '#8b8b96'],
  dll: ['DLL', '#8b8b96'], zip: ['ZIP', '#d8a657'], patch: ['±', '#d8a657'], diff: ['±', '#d8a657'],
  png: ['IMG', '#a074c4'], jpg: ['IMG', '#a074c4'], jpeg: ['IMG', '#a074c4'], gif: ['IMG', '#a074c4'], svg: ['SVG', '#ffb13b'],
  ico: ['IMG', '#a074c4'], lock: ['LCK', '#8b8b96'], gitignore: ['GIT', '#f14e32'], license: ['LIC', '#d8a657']
};

function fileBadge(name) {
  const lower = name.toLowerCase();
  let key = lower.includes('.') ? lower.split('.').pop() : lower;
  if (lower === 'cmakelists.txt') key = 'cmake';
  if (lower === 'makefile') key = 'mk';
  if (lower === 'license' || lower.startsWith('license.')) key = 'license';
  const [label, color] = FILE_TYPES[key] || ['', '#8b8b96'];
  const span = document.createElement('span');
  span.className = 'fbadge';
  span.style.setProperty('--c', color);
  if (label) span.textContent = label;
  else span.innerHTML = icon('file');
  return span;
}
