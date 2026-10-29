'use strict';
/* Probes every source in data/sources.json and records the search URL template
   that actually returns parseable results. Run: node scripts/probe-sources.js  */

const fs = require('fs');
const path = require('path');
const { parseResults, looksBlocked, looksLikeHtml } = require('../lib/parse');
const { isRelevant } = require('../lib/search');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'sources.json');
const QUERY = process.env.PROBE_QUERY || 'matrix';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 12000;
const CONCURRENCY = 6;

async function fetchText(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, text, contentType: res.headers.get('content-type') || '', ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : String(e && e.message || e), ms: Date.now() - started };
  }
}

function withQuery(template, q) {
  return template.replace(/\{q\}/g, encodeURIComponent(q));
}

async function tryTemplate(src, template) {
  const url = withQuery(template, QUERY);
  const r = await fetchText(url);
  if (r.error) return { result: 0, note: r.error, url, ms: r.ms };
  if (!r.ok) return { result: 0, note: 'http ' + r.status, url, ms: r.ms };
  if (!looksLikeHtml(r.text, r.contentType)) return { result: 0, note: 'not html', url, ms: r.ms };
  if (looksBlocked(r.text)) return { result: 0, note: 'blocked/challenge', url, ms: r.ms };

  const { items, parser } = parseResults(r.text, r.finalUrl, src.parser === 'auto' ? null : src.parser);
  // Only count cards that actually mention the query; nav/logo cards are noise.
  const useful = items.filter(it => isRelevant(it.title, QUERY));
  return { result: useful.length, parser, note: useful.length ? 'ok' : 'no results', url, finalUrl: r.finalUrl, ms: r.ms, sample: useful.slice(0, 3).map(i => i.title) };
}

async function runPool(list, worker, concurrency) {
  let i = 0;
  const results = new Array(list.length);
  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      results[idx] = await worker(list[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

(async () => {
  const sources = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const targets = sources.filter(s => s.kind === 'stream');
  console.log(`Probing ${targets.length} sources for "${QUERY}"...\n`);

  // Round 1: the most common template.
  const round1 = await runPool(targets, async (src) => {
    const t = src.searchTemplates[0];
    const r = await tryTemplate(src, t);
    const mark = r.result > 0 ? 'OK ' : '.. ';
    console.log(`${mark}${src.name.padEnd(18)} ${String(r.result).padStart(2)} results  ${r.note}  (${r.ms}ms)`);
    return r;
  }, CONCURRENCY);

  const failed = [];
  targets.forEach((src, i) => {
    if (round1[i].result > 0) {
      src.search = src.searchTemplates[0];
      src.parser = round1[i].parser || 'auto';
      src.verified = true;
      src.enabled = true;
      src.latencyMs = round1[i].ms;
      src.note = 'ok';
      src.lastChecked = new Date().toISOString();
      if (round1[i].finalUrl) {
        try {
          const o = new URL(round1[i].finalUrl).origin;
          src.origin = o;
          src.search = src.search.replace(/^https?:\/\/[^/]+/, o);
        } catch {}
      }
    } else {
      failed.push({ src, reason: round1[i].note });
    }
  });

  // Round 2: remaining templates for failures.
  console.log(`\nRetrying ${failed.length} sources with alternate search paths...\n`);
  const round2 = await runPool(failed, async (entry) => {
    const { src } = entry;
    let best = { result: 0, note: entry.reason, template: src.searchTemplates[0] };
    for (let t = 0; t < src.searchTemplates.length; t++) {
      const r = await tryTemplate(src, src.searchTemplates[t]);
      if (r.result > best.result) best = { ...r, template: src.searchTemplates[t] };
      if (r.result > 0) break;
    }
    const mark = best.result > 0 ? 'OK ' : 'XX ';
    console.log(`${mark}${src.name.padEnd(18)} ${String(best.result).padStart(2)} results  ${best.note}  (${best.ms}ms)`);
    return best;
  }, CONCURRENCY);

  failed.forEach((entry, i) => {
    const { src } = entry;
    const r = round2[i];
    if (r.result > 0) {
      src.search = r.template || src.searchTemplates[0];
      src.parser = r.parser || 'auto';
      src.verified = true;
      src.enabled = true;
      src.note = 'ok';
      if (r.finalUrl) {
        try {
          const o = new URL(r.finalUrl).origin;
          src.origin = o;
          src.search = src.search.replace(/^https?:\/\/[^/]+/, o);
        } catch {}
      }
    } else {
      src.verified = false;
      src.enabled = false;
      src.note = r.note || 'no results';
    }
    src.latencyMs = r.ms;
    src.lastChecked = new Date().toISOString();
  });

  fs.writeFileSync(DATA, JSON.stringify(sources, null, 2));
  const ok = sources.filter(s => s.verified);
  const dead = sources.filter(s => !s.verified);
  console.log(`\nVerified ${ok.length}/${sources.length}`);
  console.log('Working: ' + ok.map(s => s.name).join(', '));
  console.log('No server-rendered results / blocked: ' + dead.map(s => `${s.name} (${s.note})`).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
