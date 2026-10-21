// Streams one chat completion from an OpenAI-compatible server or from Ollama's native API.
// Ported from the desktop app's main process, minus Electron (no IPC; callers pass onDelta).
// `profile` = { name, baseUrl, apiKey, model, temperature, contextLength }.

const ollamaCache = new Map();

function apiHeaders(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  return h;
}
function apiUrl(p, suffix) {
  return p.baseUrl.trim().replace(/\/+$/, '') + suffix;
}
function ollamaRoot(p) {
  return p.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

// Only Ollama answers GET /api/version with {"version": ...}; check once per server URL.
async function isOllama(p) {
  if (p.kind === 'openai') return false;
  if (p.kind === 'ollama') return true;
  const root = ollamaRoot(p);
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

class ModelError extends Error {
  constructor(message, { status, retryable, cause } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = !!retryable;
    if (cause) this.cause = cause;
  }
}

function classify(err, p) {
  if (err instanceof ModelError) return err;
  if (err.name === 'AbortError') return err;
  const code = err.cause?.code || err.code;
  const net = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || /fetch failed|terminated|network/i.test(err.message);
  const msg = code === 'ECONNREFUSED' ? `Could not connect to ${p.baseUrl} (is the server running?)` : err.message;
  return new ModelError(msg, { retryable: net, cause: err });
}

async function streamOpenAI(p, payload, signal, onDelta) {
  const body = { model: p.model, messages: payload.messages, stream: true, temperature: Number(p.temperature ?? 0.2) };
  if (payload.tools?.length) body.tools = payload.tools;
  const res = await fetch(apiUrl(p, '/chat/completions'), { method: 'POST', headers: apiHeaders(p), body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text();
    throw new ModelError(`HTTP ${res.status} from ${p.baseUrl}: ${text.slice(0, 600)}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  }
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let finishReason = null;
  let usage = null;
  const decoder = new TextDecoder();
  let buffer = '';

  const handleChunk = (json) => {
    if (json.usage?.prompt_tokens) usage = { promptTokens: json.usage.prompt_tokens, contextLength: Number(p.contextLength) || 0 };
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === 'string' && r) reasoning += r;
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      onDelta?.(d.content);
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
        if (args !== undefined && args !== null) slot.function.arguments += typeof args === 'string' ? args : JSON.stringify(args);
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
  return { content, reasoning, toolCalls: calls, finishReason, usage };
}

async function streamOllama(p, payload, signal, onDelta) {
  const root = ollamaRoot(p);
  const contextLength = Number(p.contextLength) || 32768;
  const body = {
    model: p.model,
    messages: toOllamaMessages(payload.messages),
    stream: true,
    options: { temperature: Number(p.temperature ?? 0.2), num_ctx: contextLength }
  };
  if (payload.tools?.length) body.tools = payload.tools;
  const res = await fetch(`${root}/api/chat`, { method: 'POST', headers: apiHeaders(p), body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text();
    throw new ModelError(`HTTP ${res.status} from ${root}: ${text.slice(0, 600)}`, { status: res.status, retryable: res.status >= 500 });
  }
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let finishReason = null;
  let promptTokens = 0;
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (j) => {
    if (j.error) throw new ModelError(j.error);
    const m = j.message || {};
    if (m.thinking) reasoning += m.thinking;
    if (m.content) {
      content += m.content;
      onDelta?.(m.content);
    }
    for (const tc of m.tool_calls || []) {
      const args = tc.function?.arguments;
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: { name: tc.function?.name || '', arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) }
      });
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
  return { content, reasoning, toolCalls, finishReason, usage: { promptTokens, contextLength } };
}

// One request against one profile. Throws ModelError (retryable flag set for network, 429, 5xx).
async function streamChat(profile, payload, { signal, onDelta } = {}) {
  try {
    const result = (await isOllama(profile)) ? await streamOllama(profile, payload, signal, onDelta) : await streamOpenAI(profile, payload, signal, onDelta);
    return result;
  } catch (err) {
    throw classify(err, profile);
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

// Tries the profiles in order (hosted first, local as the fallback). Retryable errors get a
// couple of backoff retries on the same profile; if it still fails, or the error is permanent
// (bad key, bad model name), the next profile takes over. `state.index` is sticky: once a
// profile has been abandoned for a run, later requests start from the one that worked.
async function chatWithFallback(profiles, payload, { signal, onDelta, state = { index: 0 }, onFallback, retries = 2, backoffMs = 1500 } = {}) {
  let lastErr;
  for (let i = state.index; i < profiles.length; i++) {
    const profile = profiles[i];
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await streamChat(profile, payload, { signal, onDelta });
        state.index = i;
        return { ...result, profile };
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = err;
        if (!err.retryable || attempt === retries) break;
        await sleep(backoffMs * 2 ** attempt, signal);
      }
    }
    if (i + 1 < profiles.length) onFallback?.({ from: profile, to: profiles[i + 1], error: lastErr });
  }
  throw lastErr || new ModelError('No model profile configured.');
}

module.exports = { streamChat, chatWithFallback, ModelError, isOllama };
