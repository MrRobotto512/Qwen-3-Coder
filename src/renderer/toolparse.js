'use strict';

// Parses tool calls that models write as text instead of structured tool_calls. Kept free of
// app state (the known tool names are passed in) so it can be unit-tested in Node.
// Formats handled:
// - JSON in tags: <tool_call>{"name": ..., "arguments": {...}}</tool_call>
// - Qwen3-Coder XML: <function=name><parameter=key>value</parameter></function> (tags may be missing)
// - bare JSON, often in a ```json fence: {"name": "list_files", "arguments": {...}}

const TOOL_TEXT_MARKER = /<tool_call>|<function=[\w.-]+>/;
const MULTILINE_PARAMS = new Set(['content', 'old_text', 'new_text']);

function jsonToolCallRe(names) {
  return new RegExp(`(?:\`\`\`[\\w-]*[ \\t]*\\r?\\n\\s*)?\\{\\s*"name"\\s*:\\s*"(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})"`);
}

function textToolCallStart(content, names) {
  const indexes = [TOOL_TEXT_MARKER.exec(content), jsonToolCallRe(names).exec(content)].filter(Boolean).map((m) => m.index);
  return indexes.length ? Math.min(...indexes) : -1;
}

// Returns the balanced {...} object starting at `from`, respecting strings.
function readJsonObject(text, from) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return text.slice(from, i + 1);
    }
  }
  return null;
}

function extractTextToolCalls(content, names) {
  const start = textToolCallStart(content, names);
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
  } else if (!tail.includes('<tool_call>')) {
    const known = new Set(names);
    const re = /\{\s*"name"\s*:/g;
    let m;
    while ((m = re.exec(tail))) {
      const json = readJsonObject(tail, m.index);
      if (!json) break;
      re.lastIndex = m.index + json.length;
      try {
        const obj = JSON.parse(json);
        const args = obj.arguments ?? obj.parameters;
        if (known.has(obj.name) && args !== undefined) add(obj.name, typeof args === 'string' ? JSON.parse(args) : args);
      } catch {
        /* not a tool call */
      }
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

// Does a reply end by announcing an action it never took ("Let's start by…:", "I'll now ask…")?
// Kept narrow on purpose: a real final answer summarizes what was done, it doesn't announce the
// very next step. Used to push back on announce-then-stop replies instead of ending the task.
function announcesAction(text) {
  const tail = String(text || '').trim().slice(-220);
  if (!tail) return false;
  if (/[:：]\s*$/.test(tail)) return true;
  return /\b(let'?s (start|begin|proceed|now|first|ask|verify|fetch|run|install|check|create|search)|i('|’)?ll (now |first |start )?(ask|fetch|run|install|search|check|create|write|verify|begin)|next,? (i|we) (will|need to)|(i|we) (will|need to) (now |first )?(ask|fetch|run|install|search|check|create|write|verify))\b[^.]*[.!]?\s*$/i.test(tail);
}

// Is a reply a step-by-step instruction list for the user ("Step 1: …", numbered how-to)?
// Used only when a task ran no tools at all: an agent asked to do something should perform the
// steps, not hand them over. A short answer or a brief list of options is left alone.
function looksLikeInstructions(text) {
  const t = String(text || '');
  if (t.length < 200) return false;
  const numbered = (t.match(/^\s{0,3}\d+\.\s/gm) || []).length;
  const stepHeads = (t.match(/^#{0,4}\s*(\*\*)?step\s*\d/gim) || []).length;
  // 'steps' ("Step 3: …" headings) is unmistakably a how-to, even mid-task; a numbered 'list'
  // could also be a legitimate final summary, so the caller treats it with more care.
  if (stepHeads >= 2) return 'steps';
  if (numbered >= 4) return 'list';
  return false;
}

// Remove <system-reminder> blocks a model wrote into its own reply. Only the app issues those;
// a forged one ("I can't interact with the file system, I'll simulate…") poisons every later
// turn, so it must never reach the history or the screen. Returns the cleaned text and whether
// anything was removed; an unclosed block at the end of the reply is removed too.
function stripFakeReminders(text) {
  const t = String(text || '');
  const cleaned = t.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, '').trim();
  return { text: cleaned, found: cleaned !== t.trim() };
}

// Does a model error mean "busy right now, try again / try a sibling"? (As opposed to a wrong
// key, a missing model, or a network that is down.)
function isBusyModelError(text) {
  return /\b(503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|rate.?limit|try again later|server had an error)\b/i.test(String(text || ''));
}

// Sibling models worth trying when one is overloaded, strongest first.
const GEMINI_FAMILY = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
function modelAlternates(model) {
  const m = String(model || '');
  if (!/^gemini-/i.test(m)) return [];
  return GEMINI_FAMILY.filter((x) => x !== m);
}

const ToolParseExports = { TOOL_TEXT_MARKER, jsonToolCallRe, textToolCallStart, readJsonObject, extractTextToolCalls, announcesAction, looksLikeInstructions, stripFakeReminders, isBusyModelError, modelAlternates, GEMINI_FAMILY };
if (typeof module !== 'undefined' && module.exports) module.exports = ToolParseExports;
if (typeof window !== 'undefined') window.ToolParse = ToolParseExports;
