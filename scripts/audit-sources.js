'use strict';
/* Audits every source against several queries and demotes sources that only
   produced navigation/logo false positives. Run: node scripts/audit-sources.js */

const fs = require('fs');
const path = require('path');
const { parseResults, parseJsonResults, looksBlocked, looksLikeHtml } = require('../lib/parse');
const { isRelevant, searchUrlFor } = require('../lib/search');

const DATA = path.join(__dirname, '..', 'data', 'sources.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const QUERIES = ['inception', 'the matrix', 'breaking bad'];
const CONCURRENCY = 6;

async function fetchAny(url, json) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'user-agent': UA,
        accept: json ? 'application/json,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    return { status: r.status, final: r.url, ct: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e) };
  }
}

async function testSource(src, query) {
  const url = searchUrlFor(src, query);
  const json = src.parser === 'json';
  const r = await fetchAny(url, json);
  if (r.error) return { n: 0, note: r.error, ms: 0 };
  if (r.status !== 200) return { n: 0, note: 'http ' + r.status, ms: 0 };
  let items;
  if (json) {
    try { items = parseJsonResults(JSON.parse(r.text), src); }
    catch { return { n: 0, note: 'bad json', ms: 0 }; }
  } else {
    if (!looksLikeHtml(r.text, r.ct) || looksBlocked(r.text)) return { n: 0, note: 'blocked', ms: 0 };
    items = parseResults(r.text, r.final, src.parser === 'auto' ? null : src.parser).items;
  }
  const good = items.filter(i => isRelevant(i.title, query));
  return { n: good.length, note: good.length ? 'ok' : 'no relevant results', ms: 0, sample: good.slice(0, 2).map(i => i.title) };
}

async function runPool(list, worker, limit) {
  let i = 0;
  const out = new Array(list.length);
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await worker(list[idx], idx);
    }
  }));
  return out;
}

(async () => {
  const sources = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const targets = sources.filter(s => s.kind === 'stream' && s.search);
  console.log(`Auditing ${targets.length} sources with ${QUERIES.length} queries...\n`);

  const results = await runPool(targets, async (src) => {
    const per = [];
    for (const q of QUERIES) per.push(await testSource(src, q));
    return { src, per };
  }, CONCURRENCY);

  for (const { src, per } of results) {
    const passed = per.filter(x => x.n > 0).length;
    const total = per.reduce((a, x) => a + x.n, 0);
    const was = !!src.verified;
    const ok = passed >= 2 && total >= 2;
    src.verified = ok;
    src.enabled = ok;
    src.note = ok ? `ok · ${passed}/${QUERIES.length} queries` : (per.find(x => x.n === 0)?.note || 'no results');
    src.sample = per.flatMap(x => x.sample || []).slice(0, 5);
    src.lastChecked = new Date().toISOString();
    const tag = ok ? (was ? 'KEEP' : 'PROMOTE') : (was ? 'DEMOTE' : 'skip');
    console.log(`${tag.padEnd(8)} ${src.name.padEnd(16)} ${passed}/${QUERIES.length} queries, ${total} hits  ${src.note}`);
  }

  fs.writeFileSync(DATA, JSON.stringify(sources, null, 2));
  const live = sources.filter(s => s.verified);
  console.log(`\nLive sources: ${live.length}/${sources.length}`);
  console.log(live.map(s => s.name).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
