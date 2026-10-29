'use strict';

const STOPWORDS = new Set(['the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'a', 'an', 'is', 'at', 'by', 'with']);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(query) {
  return normalizeText(query)
    .split(' ')
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

/** True when a scraped title plausibly belongs to the query we sent.
 *  Keeps greedy "related links" from leaking into search results. */
function isRelevant(title, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const t = normalizeText(title);
  if (!t) return false;
  if (t === normalizeText(query)) return true;
  // Require every long token (>=4 chars) to appear, so "matrix reloaded" doesn't
  // return plain "Matrix" noise, while short words remain optional.
  const long = tokens.filter(x => x.length >= 4);
  if (long.length && !long.every(tok => t.includes(tok))) return false;
  return tokens.some(tok => t.includes(tok));
}

function titleKey(title) {
  return normalizeText(title).replace(/\b(?:watch|stream|full|movie|online|free|hd)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeItem(item, source) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!title) return null;
  let url = '';
  try {
    const u = new URL(item.url);
    if (!/^https?:$/.test(u.protocol)) return null;
    url = u.href;
  } catch { return null; }
  let poster = '';
  if (item.poster) {
    try {
      const p = new URL(item.poster);
      if (/^https?:$/.test(p.protocol)) poster = p.href;
    } catch {}
  }
  const year = Number.isFinite(item.year) && item.year >= 1870 && item.year <= 2100 ? item.year : null;
  return {
    title,
    year,
    type: item.type === 'tv' ? 'tv' : 'movie',
    poster,
    quality: String(item.quality || '').slice(0, 12),
    url,
    source: { id: source.id, name: source.name, host: safeHost(url) }
  };
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function searchUrlFor(source, query) {
  if (!source.search) return source.url;
  return source.search.replace(/\{q\}/g, encodeURIComponent(query));
}

module.exports = { normalizeText, queryTokens, isRelevant, titleKey, sanitizeItem, searchUrlFor, safeHost };
