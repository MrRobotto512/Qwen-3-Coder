// MCP (Model Context Protocol) client. Connects to the servers configured in Settings, lists
// their tools, and calls them for the agent. Servers run as the user, so their tools go through
// the same approval flow as the built-in ones.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// serverId -> { client, transport, status, tools, error }
const servers = new Map();
let onChange = () => {};

function setOnChange(fn) {
  onChange = fn;
}

function sanitizeId(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function toolName(serverId, name) {
  return `mcp__${serverId}__${name}`;
}

function parseToolName(full) {
  const m = /^mcp__([a-z0-9_]+)__(.+)$/.exec(full);
  return m ? { serverId: m[1], tool: m[2] } : null;
}

function describe() {
  return [...servers.entries()].map(([id, s]) => ({
    id,
    status: s.status,
    error: s.error || null,
    tools: (s.tools || []).map((t) => ({ name: toolName(id, t.name), rawName: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } }))
  }));
}

function makeTransport(cfg) {
  if (cfg.type === 'http' || cfg.url) {
    return new StreamableHTTPClientTransport(new URL(cfg.url));
  }
  if (!cfg.command) throw new Error('A stdio server needs a command.');
  return new StdioClientTransport({
    command: cfg.command,
    args: Array.isArray(cfg.args) ? cfg.args : [],
    // The server's own env plus a few overrides; never the full parent environment.
    env: { ...getDefaultEnvironment(), ...(cfg.env || {}) },
    cwd: cfg.cwd || undefined,
    stderr: 'ignore'
  });
}

async function connectOne(cfg) {
  const id = sanitizeId(cfg.id || cfg.name);
  if (!id) throw new Error('Each MCP server needs a name.');
  await disconnectOne(id);
  const entry = { status: 'connecting', tools: [], error: null, cfg };
  servers.set(id, entry);
  onChange();
  try {
    const client = new Client({ name: 'qwen-workspace', version: '1.0.0' }, { capabilities: {} });
    const transport = makeTransport(cfg);
    await client.connect(transport, { timeout: 20_000 });
    const { tools } = await client.listTools();
    Object.assign(entry, { client, transport, status: 'ready', tools: tools || [] });
    client.onclose = () => {
      if (servers.get(id) === entry && entry.status === 'ready') {
        entry.status = 'disconnected';
        entry.error = 'The server stopped.';
        onChange();
      }
    };
  } catch (err) {
    entry.status = 'error';
    entry.error = cleanMcpError(err);
  }
  onChange();
  return describe().find((s) => s.id === id);
}

async function disconnectOne(id) {
  const entry = servers.get(sanitizeId(id));
  if (!entry) return;
  try {
    await entry.client?.close();
  } catch {
    /* already gone */
  }
  servers.delete(sanitizeId(id));
  onChange();
}

// Connects every configured server, replacing whatever is currently connected.
async function connectAll(configs) {
  const wanted = new Set((configs || []).filter((c) => c.enabled !== false).map((c) => sanitizeId(c.id || c.name)));
  for (const id of [...servers.keys()]) if (!wanted.has(id)) await disconnectOne(id);
  await Promise.all((configs || []).filter((c) => c.enabled !== false).map((c) => connectOne(c).catch(() => {})));
  return describe();
}

async function callTool(fullName, args, { timeout = 120_000 } = {}) {
  const parsed = parseToolName(fullName);
  if (!parsed) throw new Error(`Not an MCP tool: ${fullName}`);
  const entry = servers.get(parsed.serverId);
  if (!entry || entry.status !== 'ready') throw new Error(`MCP server "${parsed.serverId}" is not connected.`);
  const res = await entry.client.callTool({ name: parsed.tool, arguments: args || {} }, undefined, { timeout });
  // Flatten the content blocks into text the model can read.
  const text = (res.content || [])
    .map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return `[image: ${c.mimeType || 'image'}]`;
      if (c.type === 'resource') return c.resource?.text || `[resource: ${c.resource?.uri || ''}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return { text: text || '(no output)', isError: !!res.isError };
}

function cleanMcpError(err) {
  const msg = String(err?.message || err);
  if (/ENOENT/.test(msg)) return 'Command not found. Is it installed and on your PATH? (On Windows, Node-based servers need Node.js installed.)';
  if (/timed out|timeout/i.test(msg)) return 'The server did not respond in time.';
  return msg.slice(0, 400);
}

module.exports = { connectAll, connectOne, disconnectOne, callTool, describe, setOnChange, parseToolName, toolName, sanitizeId };
