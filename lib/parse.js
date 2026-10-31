'use strict';

/* Lightweight, dependency-free HTML result extraction for the many different
   streaming front-ends in our source list. No external packages required. */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  '#34': '"', '#38': '&', '#x27': "'", '#x2f': '/', '#x3a': ':'
};

function decodeEntities(input) {
  return String(input == null ? '' : input).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, code) => {
    const key = code.toLowerCase();
    if (ENTITIES[key] != null) return ENTITIES[key];
    if (key[0] === '#') {
      const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(n)) { try { return String.fromCodePoint(n); } catch { return m; } }
    }
    return m;
  });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function absolute(href, base) {
  if (!href) return '';
  try { return new URL(href, base).href; } catch { return ''; }
}

function cleanPoster(raw) {
  if (!raw) return '';
  let u = decodeEntities(raw).trim();
  if (!u || u.startsWith('data:') || /(?:^|\/)(?:blank|placeholder|no-?poster|dummy)[^/]*\.(?:gif|png|svg|jpg|webp)/i.test(u)) return '';
  u = absolute(u, 'https://image.tmdb.org/');
  if (!/^https?:\/\//i.test(u)) return '';
  try {
    const parsed = new URL(u);
    // wsrv.nl / images.weserv.nl style proxy: recover the original image URL.
    if (/(?:^|\.)wsrv\.nl$/i.test(parsed.hostname) || /(?:^|\.)weserv\.nl$/i.test(parsed.hostname)) {
      const inner = parsed.searchParams.get('url');
      if (inner && /^https?:\/\//i.test(inner)) u = inner;
    }
  } catch { return ''; }
  return u;
}

function posterFrom(html, base) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const candidates = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'src'];
    for (const a of candidates) {
      const p = cleanPoster(attr(tag, a));
      if (p && !/\.svg(?:$|\?)/i.test(p)) return p;
    }
  }
  return '';
}

function yearFrom(text) {
  const m = String(text || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

const JUNK_TITLES = new Set([
  'home', 'movies', 'movie', 'tv', 'tv shows', 'tv show', 'series', 'anime', 'sports',
  'login', 'sign in', 'register', 'search', 'browse', 'genres', 'genre', 'trending',
  'popular', 'top imdb', 'top rated', 'latest', 'new', 'watch', 'watch now', 'play',
  'next', 'previous', 'prev', 'share', 'submit', 'contact', 'dmca', 'privacy', 'terms',
  'movies & tv', 'movies and tv', 'all', 'more', 'see all', 'view all', 'calendar',
  'الرئيسية', 'افلام', 'أفلام', 'مسلسلات', 'مسلسل', 'انمي', 'أنمي', 'بحث', 'مشاهدة',
  'تسجيل الدخول', 'تسجيل', 'المزيد', 'الحلقات', 'الافلام', 'المسلسلات', 'جميع الحقوق محفوظة'
]);

function cleanTitle(raw) {
  return decodeEntities(String(raw || ''))
    .replace(/\s+/g, ' ')
    .replace(/^image\s+(?=\S)/i, '')
    .replace(/^\d+(?:\.\d+)?\s+(?=(?:WEB-?Rip|Blu-?Ray|HDTS|CAM|4K|2160p|1080p|720p)\b)/i, '')
    .replace(/^(?:WEB-?Rip|Blu-?Ray|HDTS|CAM|4K|2160p|1080p|720p)\s+(?=\S)/i, '')
    .replace(/\s+(?:poster|cover|thumbnail|movie poster|tv poster)$/i, '')
    .replace(/\s*[-–—|]\s*(?:watch|stream)\s+.*$/i, '')
    .replace(/^[\s|·•\-–—]+|[\s|·•\-–—]+$/g, '')
    .trim();
}

function isUsefulTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (t.length < 1 || t.length > 140) return false;
  if (JUNK_TITLES.has(t)) return false;
  if (/\b(logo|discord|telegram|whatsapp|join our|advertisement|sponsored)\b/i.test(t)) return false;
  if (/^(watch|stream)\b.*\b(free|online|hd)\b/i.test(t)) return false;
  if (/^(home|movies|tv shows)\s*[-|–]/i.test(t)) return false;
  return true;
}

/* ---------- Parser 1: "flixer" family cards (Zoechip, MyFlixer, HDToday, …) ---------- */

function parseFlixerCards(html, pageUrl) {
  const items = [];
  const blockRe = /<div[^>]+class="[^"]*\bflw-item\b[^"]*"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = blockRe.exec(html))) starts.push({ index: m.index, end: blockRe.lastIndex });
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : starts[i].index + 4000);
    const heading = block.match(/<h[23][^>]*class="[^"]*film-name[^"]*"[^>]*>([\s\S]*?)<\/h[23]>/i);
    const anchorTag = (heading ? heading[1] : block).match(/<a\b[^>]*>/i);
    const anchorHtml = heading ? heading[1] : block;
    const href = anchorTag ? absolute(attr(anchorTag[0], 'href'), pageUrl) : '';
    const title = cleanTitle((anchorTag && attr(anchorTag[0], 'title')) || (heading ? stripTags(heading[1]) : ''));
    if (!href || !isUsefulTitle(title)) continue;
    const typeLabel = (block.match(/fdi-type"[^>]*>\s*([^<]+)/i) || [])[1] || '';
    const quality = (block.match(/film-poster-quality"[^>]*>\s*([^<]+)/i) || [])[1] || '';
    const info = block.match(/<div[^>]*class="[^"]*fd-infor[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const infoText = info ? stripTags(info[1]) : '';
    items.push({
      title,
      url: href,
      poster: posterFrom(block, pageUrl),
      year: yearFrom(infoText) || yearFrom(title),
      type: /\bTV\b|series|tv-show|season|episode/i.test(typeLabel + ' ' + href) ? 'tv' : 'movie',
      quality: cleanTitle(quality),
      extra: infoText
    });
  }
  return dedupe(items);
}

/* ---------- Parser 2: generic poster/title anchors ---------- */

const RESULT_PATH = /\/(?:movie|movies|tv|tv-?show|tvshows|series|watch|title|film|films|anime|show|play|مسلسل|مسلسلات|فيلم|افلام|أفلام|انمي|أنمي|حلقة|حلقات|مشاهدة)\//i;
const BAD_PATH = /\/(?:genre|genres|country|year|category|tag|tags|search|login|register|account|user|profile|provider|lang|language|dmca|contact|privacy|terms|about|faq|blog|news|calendar)\b/i;
const BAD_EXACT_PATH = /^\/(?:home|movies?|tv|tv-shows?|series|anime|sports|trending|popular|top-imdb|new|latest)?\/?$/i;

function parseGeneric(html, pageUrl) {
  const items = [];
  let pageHost = '';
  try { pageHost = new URL(pageUrl).hostname.replace(/^www\./i, ''); } catch {}
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const tag = '<a' + m[1] + '>';
    const inner = m[2];
    const hrefRaw = attr(tag, 'href');
    if (!hrefRaw || /^(?:#|javascript:|mailto:|tel:)/i.test(hrefRaw)) continue;
    const href = absolute(hrefRaw, pageUrl);
    if (!href || !/^https?:/i.test(href)) continue;
    let parsed;
    try { parsed = new URL(href); } catch { continue; }
    // Stay on the source's own site: external links are ads, socials or trackers.
    if (pageHost && parsed.hostname.replace(/^www\./i, '') !== pageHost) continue;
    let pathname = parsed.pathname;
    try { pathname = decodeURIComponent(pathname); } catch {}
    if (BAD_PATH.test(pathname) || BAD_EXACT_PATH.test(pathname)) continue;
    const img = /<img\b[^>]*>/i.test(inner);
    if (!RESULT_PATH.test(pathname) && !img) continue;
    const title = cleanTitle(attr(tag, 'title') || attr((inner.match(/<img\b[^>]*>/i) || [''])[0], 'alt') || stripTags(inner));
    if (!isUsefulTitle(title)) continue;
    const context = html.slice(m.index, m.index + 700);
    const type = /\/(?:tv|tv-?show|series|anime)\//i.test(pathname) ? 'tv' : 'movie';
    items.push({
      title,
      url: href,
      poster: posterFrom(inner, pageUrl),
      year: yearFrom(attr(tag, 'title')) || yearFrom(stripTags(inner)) || yearFrom(context),
      type,
      quality: (context.match(/\b(4K|2160p|1080p|720p|CAM|HDTS|HD)\b/) || [])[1] || '',
      extra: ''
    });
    if (items.length >= 60) break;
  }
  return dedupe(items);
}

/* ---------- Parser 3: JSON-LD (Next.js / custom apps) ---------- */

function walkJson(value, visit, depth = 0) {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) { for (const v of value) walkJson(v, visit, depth + 1); return; }
  if (typeof value === 'object') {
    visit(value);
    for (const k of Object.keys(value)) walkJson(value[k], visit, depth + 1);
  }
}

function firstImage(image) {
  if (!image) return '';
  if (typeof image === 'string') return cleanPoster(image);
  if (Array.isArray(image)) return firstImage(image[0]);
  if (typeof image === 'object') return cleanPoster(image.url || image.contentUrl || image.src || '');
  return '';
}

function parseJsonLd(html, pageUrl) {
  const items = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    walkJson(data, (obj) => {
      const type = String(obj['@type'] || '');
      if (!/Movie|TVSeries|TVEpisode|VideoObject|CreativeWork|ItemList/i.test(type)) return;
      const rawUrl = obj.url || obj['@id'] || (obj.mainEntityOfPage && (obj.mainEntityOfPage.url || obj.mainEntityOfPage)) || '';
      const url = absolute(typeof rawUrl === 'string' ? rawUrl : '', pageUrl);
      const title = cleanTitle(obj.name || obj.headline || '');
      if (!url || !isUsefulTitle(title)) return;
      if (!RESULT_PATH.test(new URL(url).pathname) && !/Movie|TVSeries|TVEpisode|VideoObject/i.test(type)) return;
      items.push({
        title,
        url,
        poster: firstImage(obj.image),
        year: yearFrom(obj.datePublished || obj.firstAirDate || obj.dateCreated || '') || null,
        type: /TVSeries|TVEpisode/i.test(type) ? 'tv' : 'movie',
        quality: '',
        extra: cleanTitle(obj.description || '').slice(0, 160)
      });
    });
  }
  return dedupe(items);
}

/* ---------- helpers ---------- */

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.url.split('?')[0].replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function looksBlocked(html) {
  if (!html) return true;
  if (html.length > 250000) return false;
  return /just a moment|checking your browser|cf_chl_|attention required|enable javascript and cookies|ddos-guard|cf-turnstile/i.test(html)
    && !/film-poster-img|flw-item|"@type"\s*:\s*"Movie"/i.test(html);
}

function looksLikeHtml(text, contentType) {
  if (/text\/html|application\/xhtml/i.test(contentType || '')) return true;
  return /<html|<!doctype html|<body/i.test((text || '').slice(0, 500));
}

function parseResults(html, pageUrl, hint) {
  let items = [];
  let parser = 'none';
  if (hint !== 'generic' && (hint === 'flixer' || /\bflw-item\b/.test(html))) {
    items = parseFlixerCards(html, pageUrl);
    if (items.length) parser = 'flixer';
  }
  if (!items.length) {
    items = parseGeneric(html, pageUrl);
    if (items.length) parser = 'generic';
  }
  if (!items.length) {
    items = parseJsonLd(html, pageUrl);
    if (items.length) parser = 'jsonld';
  }
  return { items, parser };
}

/* ---------- Parser 4: JSON search APIs (TMDB-style responses) ---------- */

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function findResultArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['results', 'items', 'titles', 'movies', 'shows', 'data']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.data && typeof data.data === 'object') return findResultArray(data.data);
  return [];
}

function parseJsonResults(data, source) {
  const arr = findResultArray(data);
  const items = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.media_type || '').toLowerCase() === 'person') continue;
    const title = cleanTitle(pick(row, ['title', 'name', 'original_title', 'original_name']));
    if (!isUsefulTitle(title)) continue;

    const kindRaw = String(pick(row, ['media_type', 'type', 'mediaType', 'kind'])).toLowerCase();
    const type = /tv|show|series/.test(kindRaw) ? 'tv' : 'movie';

    const id = pick(row, ['tmdbId', 'tmdb_id', 'id']);
    let url = String(pick(row, ['url', 'href', 'link', 'watch_url', 'web_url']));
    if (url && !/^https?:/i.test(url)) url = absolute(url, source.origin || '');
    if (!url && source.linkTemplate && id !== '') {
      url = source.linkTemplate.replace(/\{type\}/g, type).replace(/\{id\}/g, String(id)).replace(/\{slug\}/g, String(pick(row, ['slug'])));
    }
    if (!url || !/^https?:/i.test(url)) continue;

    let poster = String(pick(row, ['poster_path', 'posterPath', 'poster', 'poster_url', 'posterUrl', 'image']));
    if (poster && poster.startsWith('/')) poster = 'https://image.tmdb.org/t/p/w342' + poster;
    poster = cleanPoster(poster);

    const date = String(pick(row, ['release_date', 'releaseDate', 'first_air_date', 'firstAirDate', 'year', 'date']));
    items.push({
      title,
      url,
      poster,
      year: yearFrom(date),
      type,
      quality: String(pick(row, ['quality', 'resolution'])).slice(0, 12),
      extra: cleanTitle(pick(row, ['overview', 'description'])).slice(0, 160)
    });
  }
  return dedupe(items);
}

module.exports = {
  decodeEntities, stripTags, attr, absolute, cleanPoster, cleanTitle,
  parseFlixerCards, parseGeneric, parseJsonLd, parseResults, parseJsonResults,
  looksBlocked, looksLikeHtml, yearFrom, dedupe
};
