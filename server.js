'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseResults, parseJsonResults, looksBlocked, looksLikeHtml } = require('./lib/parse');
const { isRelevant, sanitizeItem, searchUrlFor, safeHost } = require('./lib/search');

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data', 'sources.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SOURCE_TIMEOUT = Number(process.env.SOURCE_TIMEOUT || 8500);
const MAX_RESULTS_PER_SOURCE = 30;
const SEARCH_TTL = 4 * 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/* ---------------- source registry ---------------- */

let sourceCache = { mtime: 0, list: [] };
function loadSources() {
  try {
    const st = fs.statSync(DATA);
    if (st.mtimeMs !== sourceCache.mtime) {
      const parsed = JSON.parse(fs.readFileSync(DATA, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('sources.json must be an array');
      sourceCache = { mtime: st.mtimeMs, list: parsed };
      console.log(`Loaded ${parsed.length} sources (${parsed.filter(s => s.verified).length} verified)`);
    }
  } catch (e) {
    console.error('Could not load sources.json:', e.message);
  }
  return sourceCache.list;
}
loadSources();

/* ---------------- tiny concurrency pool ---------------- */

function createPool(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const searchPool = createPool(8);

/* ---------------- search cache ---------------- */

const searchCache = new Map();
function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { searchCache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  searchCache.set(key, { value, expires: Date.now() + SEARCH_TTL });
  if (searchCache.size > 120) searchCache.delete(searchCache.keys().next().value);
}

/* ---------------- one source ---------------- */

function statusFromError(e) {
  if (!e) return 'error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  return 'error';
}

async function fetchSearchPage(url, timeoutMs, wantsJson) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': UA,
      accept: wantsJson ? 'application/json,text/plain;q=0.9,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache'
    }
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.httpStatus = res.status;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  if (!wantsJson && !looksLikeHtml('', type)) {
    const err = new Error('Not HTML');
    err.kind = 'not-html';
    throw err;
  }
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('Response too large');
  return { text, finalUrl: res.url };
}

/* A source's result feed and its human-facing search page are different things:
   JSON APIs live on a different host and would look broken in a "Search" link. */
function siteSearchUrlFor(source, query) {
  const template = source.siteSearch || (source.parser === 'json' ? '' : source.search);
  return template ? template.replace(/\{q\}/g, encodeURIComponent(query)) : '';
}

async function runSourceSearch(source, query, timeoutMs) {
  const started = Date.now();
  const searchUrl = searchUrlFor(source, query);
  const manualSearchUrl = siteSearchUrlFor(source, query);
  const base = {
    id: source.id, name: source.name, host: source.origin ? safeHost(source.origin) : '',
    searchUrl: manualSearchUrl || source.url, hasSearch: !!manualSearchUrl, manual: !source.verified
  };
  try {
    const wantsJson = source.parser === 'json';
    const { text, finalUrl } = await fetchSearchPage(searchUrl, timeoutMs, wantsJson);
    let items = [];
    let parser = wantsJson ? 'json' : 'none';
    if (wantsJson) {
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('Invalid JSON response'); }
      items = parseJsonResults(data, source);
    } else {
      if (looksBlocked(text)) throw Object.assign(new Error('Blocked by challenge page'), { kind: 'blocked' });
      const parsed = parseResults(text, finalUrl, source.parser === 'auto' ? null : source.parser);
      items = parsed.items;
      parser = parsed.parser;
    }
    const seen = new Set();
    const clean = [];
    for (const item of items) {
      if (!isRelevant(item.title, query)) continue;
      const normalized = sanitizeItem(item, source);
      if (!normalized) continue;
      const key = normalized.url.split('?')[0].replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(normalized);
      if (clean.length >= MAX_RESULTS_PER_SOURCE) break;
    }
    return { ...base, status: clean.length ? 'ok' : 'empty', count: clean.length, ms: Date.now() - started, parser, items: clean };
  } catch (e) {
    const status = e.kind === 'blocked' ? 'blocked' : e.httpStatus === 403 || e.httpStatus === 429 ? 'blocked' : statusFromError(e);
    return { ...base, status, count: 0, ms: Date.now() - started, error: e.message || String(e), items: [] };
  }
}

/* ---------------- /api/search ---------------- */

function selectSources(all, query) {
  const get = key => typeof query.get === 'function' ? query.get(key) : query[key];
  const ids = new Set(String(get('sources') || '').split(',').map(s => s.trim()).filter(Boolean));
  const tryAll = get('tryAll') === '1' || get('tryAll') === 'true';
  return all
    .filter(s => s.kind === 'stream')
    .filter(s => (ids.size ? ids.has(s.id) : true))
    .filter(s => tryAll ? true : s.verified && s.enabled !== false);
}

async function handleSearch(params, res) {
  const q = String(params.get('q') || '').replace(/\s+/g, ' ').trim();
  if (!q) return sendJson(res, 400, { error: 'Missing search query' });
  if (q.length > 80) return sendJson(res, 400, { error: 'Query is too long (max 80 characters)' });

  const tryAll = params.get('tryAll') === '1';
  const batch = params.get('batch') === '1';
  const all = loadSources();
  const selected = selectSources(all, params);
  const cacheKey = `${q.toLowerCase()}|${selected.map(s => s.id).join(',')}|${tryAll}|${batch ? 'b' : 'f'}`;
  const noCache = params.get('nocache') === '1';
  const cached = noCache ? null : cacheGet(cacheKey);
  if (cached) return sendJson(res, 200, { ...cached, cached: true });

  const started = Date.now();
  const results = await Promise.all(selected.map(source =>
    searchPool(() => runSourceSearch(source, q, tryAll && !source.verified ? 6000 : SOURCE_TIMEOUT))
  ));

  const items = [];
  const statuses = [];
  for (const r of results) {
    statuses.push({ id: r.id, name: r.name, host: r.host, status: r.status, count: r.count, ms: r.ms, searchUrl: r.searchUrl, hasSearch: r.hasSearch, manual: r.manual, error: r.error || '' });
    for (const item of r.items) items.push(item);
  }

  // Sources we did not query (unverified, when not in tryAll mode) still get a
  // direct "search on site" link so every site in the list is one click away.
  // Batched calls leave this to the browser so payloads stay small.
  if (!batch) {
    for (const s of all) {
      if (s.kind !== 'stream' || statuses.some(x => x.id === s.id)) continue;
      const manualSearchUrl = siteSearchUrlFor(s, q);
      statuses.push({ id: s.id, name: s.name, host: safeHost(s.origin || s.url), status: 'manual', count: 0, ms: 0, searchUrl: manualSearchUrl || s.url, hasSearch: !!manualSearchUrl, manual: true, error: '' });
    }
  }

  const sourceOrder = new Map(all.map((s, i) => [s.id, i]));
  statuses.sort((a, b) => (sourceOrder.get(a.id) ?? 99) - (sourceOrder.get(b.id) ?? 99));

  const payload = {
    query: q,
    tookMs: Date.now() - started,
    total: items.length,
    results: items,
    sources: statuses,
    stats: {
      searched: selected.length,
      responded: statuses.filter(s => s.status === 'ok' || s.status === 'empty').length,
      withResults: statuses.filter(s => s.status === 'ok').length,
      manual: statuses.filter(s => s.status === 'manual').length
    }
  };
  cacheSet(cacheKey, payload);
  return sendJson(res, 200, payload);
}

/* ---------------- /api/sources + /api/health ---------------- */

function handleSources(res) {
  const list = loadSources();
  return sendJson(res, 200, {
    runtime: 'node',
    sources: list.map(s => ({
      id: s.id, name: s.name, url: s.url, host: safeHost(s.origin || s.url),
      verified: !!s.verified, enabled: s.enabled !== false, kind: s.kind,
      searchUrl: s.siteSearch || (s.parser === 'json' ? null : s.search), note: s.note || '', latencyMs: s.latencyMs || null
    }))
  });
}

function handleHealth(res) {
  const list = loadSources();
  return sendJson(res, 200, {
    ok: true, runtime: 'node', uptime: Math.round(process.uptime()),
    sources: list.length, verified: list.filter(s => s.verified).length,
    cachedSearches: searchCache.size, cachedPosters: posterCache.size
  });
}

/* ---------------- image proxy (posters) ---------------- */

const posterCache = new Map();
const POSTER_TTL = 60 * 60 * 1000;

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 literals
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] === 169 && p[1] === 254 ||
      p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 ||
      p[0] === 100 && p[1] >= 64 && p[1] <= 127;
  }
  return !h.includes('.');
}

function servePlaceholder(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#16161d"/><text x="50%" y="50%" fill="#3f3f50" font-family="sans-serif" font-size="18" text-anchor="middle">No poster</text></svg>');
}

async function handlePoster(params, res) {
  const raw = params.get('url');
  if (!raw) return servePlaceholder(res);
  let target;
  try { target = new URL(raw); } catch { return servePlaceholder(res); }
  if (!/^https?:$/.test(target.protocol)) return servePlaceholder(res);
  if (isPrivateHost(target.hostname)) return servePlaceholder(res);
  if (target.port && !['80', '443'].includes(target.port)) return servePlaceholder(res);

  const key = target.href;
  const hit = posterCache.get(key);
  if (hit && Date.now() < hit.expires) {
    res.statusCode = 200;
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(hit.data);
  }

  try {
    const r = await fetch(target.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' }
    });
    if (!r.ok) return servePlaceholder(res);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|jpg|png|webp|gif|avif|svg\+xml)$/.test(type)) return servePlaceholder(res);
    const length = Number(r.headers.get('content-length') || 0);
    if (length > 8 * 1024 * 1024) return servePlaceholder(res);
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > 8 * 1024 * 1024) return servePlaceholder(res);
    posterCache.set(key, { data: buffer, type, expires: Date.now() + POSTER_TTL });
    if (posterCache.size > 400) posterCache.delete(posterCache.keys().next().value);
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  } catch {
    servePlaceholder(res);
  }
}

/* ---------------- static + http helpers ---------------- */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const acceptsGzip = /\bgzip\b/.test(((res.req && res.req.headers) || {})['accept-encoding'] || '');
  if (acceptsGzip && body.length > 1024) {
    const gz = zlib.gzipSync(body, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.end(gz);
  } else {
    res.end(body);
  }
}

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.statusCode = 403; res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    const noStore = ext === '.html' || ext === '.css' || ext === '.js';
    res.setHeader('Cache-Control', noStore ? 'no-cache' : 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(data);
  });
}

const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const win = hits.get(ip) || { start: now, count: 0 };
  if (now - win.start > 60000) { win.start = now; win.count = 0; }
  win.count++;
  hits.set(ip, win);
  if (hits.size > 2000) hits.clear();
  return win.count > 120;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.statusCode = 400; res.end('Bad request'); return; }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end('Method not allowed'); return; }

  const ip = req.socket.remoteAddress || 'local';

  if (url.pathname === '/api/search') {
    if (isRateLimited(ip)) return sendJson(res, 429, { error: 'Too many searches, slow down for a moment.' });
    try { await handleSearch(url.searchParams, res); }
    catch (e) { console.error('search failed:', e); sendJson(res, 500, { error: 'Search failed: ' + (e.message || e) }); }
    return;
  }

  if (url.pathname === '/api/sources') {
    return handleSources(res);
  }

  if (url.pathname === '/api/health') {
    return handleHealth(res);
  }

  if (url.pathname === '/poster') { await handlePoster(url.searchParams, res); return; }

  serveStatic(req, res, url.pathname);
  if (req.method === 'HEAD') res.end();
  const ms = Date.now() - started;
  if (ms > 1500) console.log(`${req.method} ${url.pathname} ${ms}ms`);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const list = loadSources();
    console.log('');
    console.log('  StreamFinder is running');
    console.log(`  -> http://localhost:${PORT}`);
    console.log(`  ${list.length} sources loaded (${list.filter(s => s.verified).length} live search)`);
    console.log('');
    console.log('  Keep this window open. Press Ctrl+C to stop.');
  });

  process.on('SIGINT', () => { console.log('\nStopping...'); server.close(() => process.exit(0)); });
}

module.exports = { handleSearch, handlePoster, handleSources, handleHealth, loadSources, sendJson };
