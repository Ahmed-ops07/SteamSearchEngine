'use strict';

/* Cloudflare Worker entry point.
   Reuses the same parser, relevance and registry as the local Node server, but
   talks to the runtime's fetch/Request/Response APIs instead of node:http. */

import sources from '../data/sources.json';
import { parseResults, parseJsonResults, looksBlocked, looksLikeHtml } from '../lib/parse.js';
import { isRelevant, sanitizeItem, searchUrlFor, safeHost } from '../lib/search.js';

let startedAt = 0;
const SOURCE_TIMEOUT = 8500;
const MAX_RESULTS_PER_SOURCE = 30;
const SEARCH_TTL = 4 * 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const POSTER_TTL = 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const searchCache = new Map();
const posterCache = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function statusFromError(e) {
  if (!e) return 'error';
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timeout';
  return 'error';
}

async function fetchSearchPage(url, timeoutMs, wantsJson) {
  const res = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: wantsJson ? 'application/json,text/plain;q=0.9,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache'
    }
  }, timeoutMs);
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

function selectSources(url) {
  const ids = new Set(String(url.searchParams.get('sources') || '').split(',').map(s => s.trim()).filter(Boolean));
  const tryAll = url.searchParams.get('tryAll') === '1' || url.searchParams.get('tryAll') === 'true';
  return sources
    .filter(s => s.kind === 'stream')
    .filter(s => (ids.size ? ids.has(s.id) : true))
    .filter(s => tryAll ? true : s.verified && s.enabled !== false);
}

async function handleSearch(url) {
  const q = String(url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
  if (!q) return json({ error: 'Missing search query' }, 400);
  if (q.length > 80) return json({ error: 'Query is too long (max 80 characters)' }, 400);

  const tryAll = url.searchParams.get('tryAll') === '1';
  const batch = url.searchParams.get('batch') === '1';
  const selected = selectSources(url);
  const cacheKey = `${q.toLowerCase()}|${selected.map(s => s.id).join(',')}|${tryAll}|${batch ? 'b' : 'f'}`;
  const noCache = url.searchParams.get('nocache') === '1';
  const cached = noCache ? null : cacheGet(cacheKey);
  if (cached) return json({ ...cached, cached: true });

  const started = Date.now();
  const results = await Promise.all(selected.map(source =>
    runSourceSearch(source, q, tryAll && !source.verified ? 6000 : SOURCE_TIMEOUT)
  ));

  const items = [];
  const statuses = [];
  for (const r of results) {
    statuses.push({ id: r.id, name: r.name, host: r.host, status: r.status, count: r.count, ms: r.ms, searchUrl: r.searchUrl, hasSearch: r.hasSearch, manual: r.manual, error: r.error || '' });
    for (const item of r.items) items.push(item);
  }

  if (!batch) {
    for (const s of sources) {
      if (s.kind !== 'stream' || statuses.some(x => x.id === s.id)) continue;
      const manualSearchUrl = siteSearchUrlFor(s, q);
      statuses.push({ id: s.id, name: s.name, host: safeHost(s.origin || s.url), status: 'manual', count: 0, ms: 0, searchUrl: manualSearchUrl || s.url, hasSearch: !!manualSearchUrl, manual: true, error: '' });
    }
  }

  const sourceOrder = new Map(sources.map((s, i) => [s.id, i]));
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
  return json(payload);
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] === 169 && p[1] === 254 ||
      p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 ||
      p[0] === 100 && p[1] >= 64 && p[1] <= 127;
  }
  return !h.includes('.');
}

function placeholder() {
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#16161d"/><text x="50%" y="50%" fill="#3f3f50" font-family="sans-serif" font-size="18" text-anchor="middle">No poster</text></svg>', {
    status: 404,
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' }
  });
}

async function handlePoster(url) {
  const raw = url.searchParams.get('url');
  if (!raw) return placeholder();
  let target;
  try { target = new URL(raw); } catch { return placeholder(); }
  if (!/^https?:$/.test(target.protocol)) return placeholder();
  if (isPrivateHost(target.hostname)) return placeholder();
  if (target.port && !['80', '443'].includes(target.port)) return placeholder();

  const key = target.href;
  const hit = posterCache.get(key);
  if (hit && Date.now() < hit.expires) {
    return new Response(hit.data, { headers: { 'content-type': hit.type, 'cache-control': 'public, max-age=86400' } });
  }

  try {
    const r = await fetchWithTimeout(target.href, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' }
    }, 9000);
    if (!r.ok) return placeholder();
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|jpg|png|webp|gif|avif|svg\+xml)$/.test(type)) return placeholder();
    const length = Number(r.headers.get('content-length') || 0);
    if (length > 8 * 1024 * 1024) return placeholder();
    const buffer = await r.arrayBuffer();
    if (buffer.byteLength > 8 * 1024 * 1024) return placeholder();
    posterCache.set(key, { data: buffer, type, expires: Date.now() + POSTER_TTL });
    if (posterCache.size > 200) posterCache.delete(posterCache.keys().next().value);
    return new Response(buffer, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } });
  } catch {
    return placeholder();
  }
}

function handleSources() {
  return json({
    runtime: 'cloudflare-worker',
    sources: sources.map(s => ({
      id: s.id, name: s.name, url: s.url, host: safeHost(s.origin || s.url),
      verified: !!s.verified, enabled: s.enabled !== false, kind: s.kind,
      searchUrl: s.siteSearch || (s.parser === 'json' ? null : s.search), note: s.note || '', latencyMs: s.latencyMs || null
    }))
  });
}

function handleHealth() {
  const now = Date.now();
  if (!startedAt || startedAt > now) startedAt = now;
  return json({
    ok: true, runtime: 'cloudflare-worker', uptime: Math.round((now - startedAt) / 1000),
    sources: sources.length, verified: sources.filter(s => s.verified).length,
    cachedSearches: searchCache.size, cachedPosters: posterCache.size
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,HEAD,OPTIONS' }
      });
    }

    try {
      if (url.pathname === '/api/search') return await handleSearch(url);
      if (url.pathname === '/api/sources') return handleSources();
      if (url.pathname === '/api/health') return handleHealth();
      if (url.pathname === '/poster') return await handlePoster(url);
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error: ' + (e.message || e) }, 500);
    }

    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
