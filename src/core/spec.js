// Task specs. A spec is a Markdown file with a small frontmatter block, or a JSON file:
//
//   ---
//   title: Add battery health screen
//   gates:
//     - name: tests
//       run: python -m pytest tests/test_battery.py -q
//       timeout: 300
//     - run: python -m py_compile tools/battery.py
//   setup:
//     - pip install -r requirements.txt
//   allow_paths:
//     - tools/
//     - tests/
//   max_steps: 60
//   max_fix_rounds: 3
//   base: main
//   ---
//   Everything after the frontmatter is the task: what to build and what "done" means.
//
// The frontmatter parser handles exactly this shape (scalars, lists of scalars, lists of
// small maps), so no YAML dependency is needed.

const fs = require('fs');

function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function scalar(v) {
  const s = unquote(v);
  if (/^(true|false)$/i.test(s) && !/^["']/.test(v.trim())) return s.toLowerCase() === 'true';
  if (/^-?\d+$/.test(s) && !/^["']/.test(v.trim())) return Number(s);
  return s;
}

function parseFrontmatter(block) {
  const out = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Spec frontmatter line ${i + 1} is not "key: value": ${line}`);
    const key = m[1].replace(/-/g, '_');
    const rest = m[2].trim();
    if (rest) {
      out[key] = scalar(rest);
      i++;
      continue;
    }
    // A block: list of scalars or list of maps.
    const items = [];
    i++;
    while (i < lines.length && (/^\s+/.test(lines[i]) || !lines[i].trim())) {
      const l = lines[i];
      if (!l.trim()) {
        i++;
        continue;
      }
      const li = /^\s+-\s*(.*)$/.exec(l);
      if (li) {
        const first = li[1];
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(first);
        if (kv && !/^["']/.test(first)) {
          const obj = { [kv[1].replace(/-/g, '_')]: scalar(kv[2]) };
          i++;
          while (i < lines.length && /^\s+[A-Za-z_][\w-]*\s*:/.test(lines[i]) && !/^\s+-/.test(lines[i])) {
            const k2 = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
            obj[k2[1].replace(/-/g, '_')] = scalar(k2[2]);
            i++;
          }
          items.push(obj);
        } else {
          items.push(scalar(first));
          i++;
        }
      } else {
        throw new Error(`Spec frontmatter line ${i + 1} is not a list item: ${l}`);
      }
    }
    out[key] = items;
  }
  return out;
}

function normalizeGates(gates) {
  return (Array.isArray(gates) ? gates : []).map((g, i) => {
    if (typeof g === 'string') return { name: `gate ${i + 1}`, command: g, timeoutSec: 600 };
    const command = g.run || g.command;
    if (!command) throw new Error(`Gate ${i + 1} has no "run" command.`);
    return { name: g.name || `gate ${i + 1}`, command: String(command), timeoutSec: Number(g.timeout) || 600 };
  });
}

function strList(v) {
  return (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
}

function normalize(raw, body) {
  const task = String(body ?? raw.task ?? '').trim();
  if (!task) throw new Error('The spec has no task text. Put the description after the frontmatter (or in "task" for JSON).');
  return {
    title: String(raw.title || task.split(/\r?\n/)[0].replace(/^#+\s*/, '').slice(0, 80) || 'task'),
    task,
    gates: normalizeGates(raw.gates),
    setup: strList(raw.setup),
    allowPaths: strList(raw.allow_paths),
    maxSteps: raw.max_steps ? Number(raw.max_steps) : undefined,
    maxFixRounds: raw.max_fix_rounds !== undefined ? Number(raw.max_fix_rounds) : 3,
    base: raw.base ? String(raw.base) : undefined,
    webResearch: raw.web_research === undefined ? undefined : !!raw.web_research
  };
}

function parseSpec(text, { json = false } = {}) {
  if (json) {
    const raw = JSON.parse(text);
    return normalize(raw, raw.task);
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) return normalize({}, text);
  return normalize(parseFrontmatter(m[1]), m[2]);
}

function loadSpecFile(file) {
  return parseSpec(fs.readFileSync(file, 'utf8'), { json: file.toLowerCase().endsWith('.json') });
}

module.exports = { parseSpec, loadSpecFile };
