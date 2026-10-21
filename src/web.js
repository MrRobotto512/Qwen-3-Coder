// Web research for the agent: search (DuckDuckGo without a key, or Brave / SearXNG) and page
// fetching with HTML converted to readable text that keeps headings, code blocks and links.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_BYTES = 3 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// ---------- search ----------
async function webSearch(settings, query, count = 8) {
  const provider = settings.searchProvider || 'duckduckgo';
  const q = encodeURIComponent(query);
  const signal = AbortSignal.timeout(20_000);
  if (provider === 'brave') {
    if (!settings.searchApiKey) throw new Error('Brave Search needs an API key (Settings → Research).');
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${count}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': settings.searchApiKey },
      signal
    });
    if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
    const json = await res.json();
    return (json.web?.results || []).slice(0, count).map((r) => ({ title: stripTags(r.title || ''), url: r.url, snippet: stripTags(r.description || '') }));
  }
  if (provider === 'searxng') {
    const base = String(settings.searxngUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('Set your SearXNG address in Settings → Research.');
    const res = await fetch(`${base}/search?q=${q}&format=json`, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status} (is the JSON format enabled on the instance?)`);
    const json = await res.json();
    return (json.results || []).slice(0, count).map((r) => ({ title: stripTags(r.title || ''), url: r.url, snippet: stripTags(r.content || '') }));
  }
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'text/html' },
    body: `q=${q}`,
    signal
  });
  if (!res.ok && res.status !== 202) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const results = parseDuckDuckGo(await res.text()).slice(0, count);
  if (!results.length) {
    throw new Error('DuckDuckGo returned no readable results (it may be rate-limiting automated searches). Try again shortly, or set up Brave Search or SearXNG in Settings → Research.');
  }
  return results;
}

// Results on html.duckduckgo.com: <a class="result__a" href="//duckduckgo.com/l/?uddg=<url>">title</a>
// followed by <a class="result__snippet">snippet</a>. Ads carry "result--ad" and are skipped.
function parseDuckDuckGo(html) {
  const out = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snip = /<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block);
    out.push({ title: stripTags(a[2]), url, snippet: snip ? stripTags(snip[1]) : '' });
  }
  return out;
}

// ---------- fetching ----------
// Web content can carry instructions aimed at the agent, so by default it may not reach
// services on this machine or the local network.
function isPrivateHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  // Canonicalize numeric IPv4 forms first (decimal like 2130706433, hex 0x7f000001, octal
  // 0177.0.0.1, short forms like 127.1), so an encoded loopback address can't slip past.
  const ip = canonicalIPv4(h);
  if (ip) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    return false;
  }
  if (h === '::1' || /^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7)); // IPv4-mapped IPv6
  return false;
}

// Any inet_aton-style IPv4 literal (1 to 4 dot-separated decimal/octal/hex numbers) to the
// canonical dotted-decimal form, or null when the host is not a numeric IPv4.
function canonicalIPv4(h) {
  if (!/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/.test(h)) return null;
  const parts = h.split('.').map((p) => (/^0x/.test(p) ? parseInt(p, 16) : /^0\d/.test(p) ? parseInt(p, 8) : parseInt(p, 10)));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const last = parts.pop();
  if (parts.some((n) => n > 255) || last >= 256 ** (4 - parts.length)) return null;
  let value = last;
  parts.forEach((n, i) => (value += n * 256 ** (3 - i)));
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

// github.com/<owner>/<repo>/blob/<ref>/<path> → the raw file, which is far easier to read.
function rewriteUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

const pageCache = new Map();

async function fetchPage(settings, rawUrl) {
  let url;
  try {
    url = new URL(rewriteUrl(String(rawUrl).trim()));
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https addresses can be fetched.');
  if (!settings.allowPrivateFetch && isPrivateHost(url.hostname)) {
    throw new Error('Fetching local or private-network addresses is turned off (Settings → Research).');
  }
  const key = url.href;
  const cached = pageCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.page;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.host}`);
  const finalUrl = new URL(res.url || url.href);
  if (!settings.allowPrivateFetch && isPrivateHost(finalUrl.hostname)) throw new Error('The page redirected to a local or private-network address.');
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!/text\/|json|xml|javascript|markdown/.test(type) && type) throw new Error(`That address is not a text page (${type.split(';')[0]}).`);

  let body = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    bytes += chunk.length;
    body += decoder.decode(chunk, { stream: true });
    if (bytes > MAX_BYTES) break;
  }
  const isHtml = /html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body);
  const page = isHtml ? htmlToText(body, finalUrl) : { title: '', text: body };
  page.url = finalUrl.href;
  page.truncated = bytes > MAX_BYTES;
  pageCache.set(key, { at: Date.now(), page });
  if (pageCache.size > 50) pageCache.delete(pageCache.keys().next().value);
  return page;
}

// Regex-based HTML → Markdown-ish text: headings, lists, code blocks, tables as rows, links as
// [text](url). Good enough for documentation pages; it is not a full HTML parser.
function htmlToText(html, base) {
  const title = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  let s = html;
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main && main[2].length > 500) s = main[2];
  else s = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(s) || [null, s])[1];
  s = s.replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|button)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');

  const blocks = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => {
    blocks.push(decodeEntities(code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n+$/, ''));
    return `\n\n@@BLOCK${blocks.length - 1}@@\n\n`;
  });
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t)}\n\n`)
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const text = stripTags(t);
      if (!text) return '';
      try {
        const abs = new URL(decodeEntities(href), base).href;
        return /^https?:/.test(abs) ? `[${text}](${abs})` : text;
      } catch {
        return text;
      }
    })
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${stripTags(t)}\``)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|div|section|table|ul|ol|blockquote|dl|dd|dt)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/@@BLOCK(\d+)@@/g, (_m, i) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``)
    .trim();
  return { title, text: s };
}

module.exports = { webSearch, fetchPage, parseDuckDuckGo, htmlToText, isPrivateHost };
