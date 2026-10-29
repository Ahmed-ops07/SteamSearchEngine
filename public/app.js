'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const LS_RECENT = 'sf:recent';
  const LS_TRY_ALL = 'sf:tryAll';

  const state = {
    query: '',
    loading: false,
    items: [],
    sources: [],
    stats: null,
    tookMs: 0,
    cached: false,
    error: '',
    type: 'all',
    sort: 'sources',
    group: true,
    tryAll: false,
    hiddenSources: new Set(),
    expanded: new Set(),
    allSources: [],
    statusById: new Map(),
    runtime: 'node',
    batchSearch: false,
    sourcesPromise: null,
    abort: null,
    manualExpanded: false
  };

  const els = {
    form: $('#searchForm'),
    q: $('#q'),
    clear: $('#clearBtn'),
    quick: $('#quickRow'),
    recent: $('#recentRow'),
    recentList: $('#recentList'),
    toolbar: $('#toolbar'),
    typeFilter: $('#typeFilter'),
    groupToggle: $('#groupToggle'),
    tryAllToggle: $('#tryAllToggle'),
    sort: $('#sortSelect'),
    strip: $('#sourceStrip'),
    statusLine: $('#statusLine'),
    statusText: $('#statusText'),
    clearFilters: $('#clearFiltersBtn'),
    results: $('#results'),
    empty: $('#empty'),
    emptyTitle: $('#emptyTitle'),
    emptyText: $('#emptyText'),
    emptyRetry: $('#emptyRetry'),
    emptyTryAll: $('#emptyTryAll'),
    errorPanel: $('#errorPanel'),
    errorText: $('#errorText'),
    errorRetry: $('#errorRetry'),
    manual: $('#manualSection'),
    manualGrid: $('#manualGrid'),
    manualToggle: $('#manualToggle'),
    sitesGrid: $('#sitesGrid'),
    sitesSub: $('#sitesSub'),
    sourcesBtn: $('#sourcesBtn'),
    dialog: $('#sourcesDialog'),
    dialogClose: $('#dialogClose'),
    dialogList: $('#dialogList'),
    dialogSub: $('#dialogSub'),
    sourceCount: $('#sourceCount'),
    heroCount: $('#heroCount'),
    footerStats: $('#footerStats'),
    refreshSources: $('#refreshSourcesBtn'),
    topbar: $('.topbar')
  };

  /* ---------------- text utils ---------------- */

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function titleKey(title) {
    return normalizeText(title).replace(/\b(?:watch|stream|full|movie|online|free|hd)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function cleanQuery(q) { return String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
  function fmtCount(n) { return new Intl.NumberFormat().format(n); }
  function plural(n, one, many) { return n === 1 ? one : many; }

  /* ---------------- icons ---------------- */

  const ICON = {
    external: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 5h5v5M19 5l-7 7M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor"/></svg>'
  };

  /* ---------------- init ---------------- */

  init();

  function init() {
    bindEvents();
    try { state.tryAll = localStorage.getItem(LS_TRY_ALL) === '1'; } catch {}
    els.tryAllToggle.checked = state.tryAll;
    renderRecent();
    state.sourcesPromise = loadSources();
    window.addEventListener('scroll', () => {
      els.topbar.classList.toggle('scrolled', window.scrollY > 8);
    }, { passive: true });

    const initial = cleanQuery(new URLSearchParams(location.search).get('q'));
    if (initial) {
      els.q.value = initial;
      runSearch(initial);
    }
  }

  function bindEvents() {
    els.form.addEventListener('submit', e => {
      e.preventDefault();
      runSearch(els.q.value);
    });

    els.q.addEventListener('input', () => {
      els.clear.hidden = !els.q.value;
    });

    els.clear.addEventListener('click', () => {
      els.q.value = '';
      els.clear.hidden = true;
      resetToHome();
      els.q.focus();
    });

    els.quick.addEventListener('click', e => {
      const btn = e.target.closest('button[data-q]');
      if (!btn) return;
      els.q.value = btn.dataset.q;
      els.clear.hidden = false;
      runSearch(btn.dataset.q);
    });

    els.recentList.addEventListener('click', e => {
      const btn = e.target.closest('button[data-q]');
      if (!btn) return;
      els.q.value = btn.dataset.q;
      els.clear.hidden = false;
      runSearch(btn.dataset.q);
    });

    els.typeFilter.addEventListener('click', e => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      state.type = btn.dataset.type;
      $$('.seg', els.typeFilter).forEach(b => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      renderResults();
    });

    els.groupToggle.addEventListener('change', () => {
      state.group = els.groupToggle.checked;
      renderResults();
    });

    els.tryAllToggle.addEventListener('change', () => {
      state.tryAll = els.tryAllToggle.checked;
      try { localStorage.setItem(LS_TRY_ALL, state.tryAll ? '1' : '0'); } catch {}
      if (state.query) runSearch(state.query);
    });

    els.sort.addEventListener('change', () => {
      state.sort = els.sort.value;
      renderResults();
    });

    els.strip.addEventListener('click', e => {
      const chip = e.target.closest('button[data-source]');
      if (!chip) return;
      const id = chip.dataset.source;
      if (id === '*') state.hiddenSources.clear();
      else if (state.hiddenSources.has(id)) state.hiddenSources.delete(id);
      else state.hiddenSources.add(id);
      renderResults();
      renderSourceStrip();
    });

    els.clearFilters.addEventListener('click', () => {
      state.hiddenSources.clear();
      renderResults();
      renderSourceStrip();
    });

    els.emptyRetry.addEventListener('click', () => runSearch(state.query, { force: true }));
    els.emptyTryAll.addEventListener('click', () => {
      state.tryAll = true;
      els.tryAllToggle.checked = true;
      try { localStorage.setItem(LS_TRY_ALL, '1'); } catch {}
      runSearch(state.query, { force: true });
    });
    els.errorRetry.addEventListener('click', () => runSearch(state.query, { force: true }));

    els.manualToggle.addEventListener('click', () => {
      state.manualExpanded = !state.manualExpanded;
      renderManual();
    });

    els.sourcesBtn.addEventListener('click', openDialog);
    els.dialogClose.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', e => {
      if (e.target === els.dialog) els.dialog.close();
    });

    els.refreshSources.addEventListener('click', async () => {
      els.refreshSources.disabled = true;
      await loadSources();
      els.refreshSources.disabled = false;
    });

    window.addEventListener('popstate', () => {
      const q = cleanQuery(new URLSearchParams(location.search).get('q'));
      if (q) { els.q.value = q; runSearch(q, { skipHistory: true }); }
      else resetToHome();
    });

    document.addEventListener('keydown', e => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        els.q.focus();
      }
      if (e.key === 'Escape' && document.activeElement === els.q && els.q.value) {
        els.q.value = '';
        els.clear.hidden = true;
        resetToHome();
      }
    });
  }

  /* ---------------- sources ---------------- */

  async function loadSources() {
    try {
      const res = await fetch('/api/sources', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('Could not load sources');
      const data = await res.json();
      state.runtime = data.runtime || 'node';
      state.batchSearch = state.runtime === 'cloudflare-worker';
      state.allSources = data.sources || [];
      els.sourceCount.textContent = state.allSources.length;
      els.heroCount.textContent = state.allSources.length;
      els.footerStats.textContent = `${state.allSources.length} sources indexed`;
      els.dialogSub.textContent = `${state.allSources.length} curated free streaming sites`;
      renderSites();
      renderDialog();
    } catch (e) {
      els.sitesSub.textContent = 'Could not load the source list. Is the local server running?';
    }
  }

  function statusDotClass(status) {
    if (status === 'ok') return 'ok';
    if (status === 'empty' || status === 'pending') return 'pending';
    if (status === 'blocked' || status === 'timeout' || status === 'error') return 'bad';
    return 'manual';
  }

  function statusLabel(status) {
    return ({
      ok: 'Live search', empty: 'No results', blocked: 'Blocked', timeout: 'Timed out',
      error: 'Error', manual: 'Open on site', pending: 'Checking'
    })[status] || 'Not checked';
  }

  function renderSites() {
    const grid = els.sitesGrid;
    grid.textContent = '';
    for (const src of state.allSources) {
      if (src.kind !== 'stream' && src.kind !== 'link') continue;
      const status = state.statusById.get(src.id) || 'manual';
      const a = document.createElement('a');
      a.className = 'site-card';
      a.href = src.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = `${src.name} — ${statusLabel(status)}`;

      const dot = document.createElement('i');
      dot.className = 'dot ' + statusDotClass(status);
      const info = document.createElement('span');
      info.className = 'site-info';
      const name = document.createElement('span');
      name.className = 'site-name';
      name.textContent = src.name;
      const host = document.createElement('span');
      host.className = 'site-host';
      host.textContent = src.host || src.url;
      info.append(name, host);
      const icon = document.createElement('span');
      icon.innerHTML = ICON.external;
      a.append(dot, info, icon.firstElementChild);
      grid.append(a);
    }
    const live = state.allSources.filter(s => s.verified).length;
    els.sitesSub.textContent = `${live} sites support live search · ${state.allSources.length - live} open directly · status updates after each search`;
  }

  function openDialog() {
    renderDialog();
    if (typeof els.dialog.showModal === 'function') els.dialog.showModal();
    else els.dialog.setAttribute('open', '');
  }

  function renderDialog() {
    const list = els.dialogList;
    list.textContent = '';
    const q = state.query;
    for (const src of state.allSources) {
      if (src.kind !== 'stream' && src.kind !== 'link') continue;
      const status = state.statusById.get(src.id) || 'manual';
      const row = document.createElement('div');
      row.className = 'dialog-row';

      const dot = document.createElement('i');
      dot.className = 'dot ' + statusDotClass(status);
      const grow = document.createElement('div');
      grow.className = 'grow';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = src.name;
      const host = document.createElement('div');
      host.className = 'host';
      host.textContent = `${src.host || src.url} · ${statusLabel(status)}`;
      grow.append(name, host);

      const lat = document.createElement('span');
      lat.className = 'lat';
      const st = state.sources.find(s => s.id === src.id);
      lat.textContent = st && st.ms ? `${st.ms} ms` : '';

      const open = document.createElement('a');
      open.href = src.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Open';

      row.append(dot, grow, lat, open);
      if (q && src.searchUrl) {
        const searchA = document.createElement('a');
        searchA.href = st && st.hasSearch ? st.searchUrl : src.searchUrl.replace('{q}', encodeURIComponent(q));
        searchA.target = '_blank';
        searchA.rel = 'noopener noreferrer';
        searchA.textContent = 'Search';
        row.append(searchA);
      }
      list.append(row);
    }
  }

  /* ---------------- searching ---------------- */

  function searchSourceIds() {
    return state.allSources
      .filter(s => s.kind === 'stream' && (state.tryAll || s.verified))
      .map(s => s.id);
  }

  function manualStatusFor(src, q) {
    const template = src.searchUrl || '';
    return {
      id: src.id,
      name: src.name,
      host: src.host || src.url || '',
      status: 'manual',
      count: 0,
      ms: 0,
      searchUrl: template ? template.replace(/\{q\}/g, encodeURIComponent(q)) : src.url,
      hasSearch: !!template,
      manual: true,
      error: ''
    };
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  function batchStats(searched, sources) {
    return {
      searched,
      responded: sources.filter(s => s.status === 'ok' || s.status === 'empty').length,
      withResults: sources.filter(s => s.status === 'ok').length,
      manual: sources.filter(s => s.status === 'manual').length
    };
  }

  /* Cloudflare Workers Free allows 50 outbound subrequests per invocation. A
     search across every source can exceed that once redirects are counted, so
     the browser sends small batches. Each batch gets its own budget. */
  async function runBatchedSearch(q, abort, options) {
    const ids = searchSourceIds();
    const batches = [];
    for (let i = 0; i < ids.length; i += 3) batches.push(ids.slice(i, i + 3));

    const started = performance.now();
    const statusById = new Map();
    const items = [];
    let cached = batches.length > 0;

    await mapLimit(batches, 6, async batch => {
      const endpoint = `/api/search?q=${encodeURIComponent(q)}&sources=${batch.join(',')}${state.tryAll ? '&tryAll=1' : ''}&batch=1${options.force ? '&nocache=1' : ''}`;
      try {
        const res = await fetch(endpoint, { signal: abort.signal, headers: { accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
        if (Array.isArray(data.results)) items.push(...data.results);
        for (const src of data.sources || []) {
          if (src.status !== 'manual') statusById.set(src.id, src);
        }
        if (!data.cached) cached = false;
      } catch (e) {
        if (e.name === 'AbortError' || abort.signal.aborted) throw e;
        cached = false;
        for (const id of batch) {
          const src = state.allSources.find(s => s.id === id) || { id, name: id, url: '', host: '' };
          statusById.set(id, { ...manualStatusFor(src, q), status: 'error', error: e.message || String(e) });
        }
      }
    });

    if (abort.signal.aborted || state.query !== q) return null;

    const sources = state.allSources
      .filter(src => src.kind === 'stream')
      .map(src => statusById.get(src.id) || manualStatusFor(src, q));
    return {
      results: items,
      sources,
      stats: batchStats(ids.length, sources),
      tookMs: Math.round(performance.now() - started),
      cached
    };
  }

  async function runSearch(rawQuery, options = {}) {
    const q = cleanQuery(rawQuery);
    if (!q) { resetToHome(); return; }

    if (state.abort) state.abort.abort();
    const abort = new AbortController();
    state.abort = abort;

    state.query = q;
    state.loading = true;
    state.error = '';
    state.items = [];
    state.sources = [];
    state.stats = null;
    state.tookMs = 0;
    state.cached = false;
    state.hiddenSources.clear();
    state.expanded.clear();
    state.manualExpanded = false;

    els.q.value = q;
    els.clear.hidden = false;

    if (!options.skipHistory) {
      const url = `${location.pathname}?q=${encodeURIComponent(q)}`;
      history.pushState({ q }, '', url);
    }
    document.title = `${q} · StreamFinder`;
    saveRecent(q);
    renderRecent();
    renderAll();

    try {
      if (state.sourcesPromise) {
        try { await state.sourcesPromise; } catch {}
        if (state.query !== q) return;
      }

      let data;
      if (state.batchSearch) {
        data = await runBatchedSearch(q, abort, options);
        if (!data) return;
      } else {
        const endpoint = `/api/search?q=${encodeURIComponent(q)}${state.tryAll ? '&tryAll=1' : ''}${options.force ? '&nocache=1' : ''}`;
        const res = await fetch(endpoint, { signal: abort.signal, headers: { accept: 'application/json' } });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
      }
      if (state.query !== q) return;

      state.items = Array.isArray(data.results) ? data.results : [];
      state.sources = Array.isArray(data.sources) ? data.sources : [];
      state.stats = data.stats || null;
      state.tookMs = data.tookMs || 0;
      state.cached = !!data.cached;
      state.loading = false;
      state.statusById = new Map(state.sources.map(s => [s.id, s.status]));
      renderAll();
      renderSites();
      renderDialog();
    } catch (e) {
      if (e.name === 'AbortError' || state.query !== q) return;
      state.loading = false;
      state.error = e.message || String(e);
      renderAll();
    }
  }

  function resetToHome() {
    if (state.abort) state.abort.abort();
    state.abort = null;
    state.query = '';
    state.loading = false;
    state.items = [];
    state.sources = [];
    state.stats = null;
    state.error = '';
    state.hiddenSources.clear();
    state.statusById.clear();
    history.pushState({}, '', location.pathname);
    document.title = 'StreamFinder — search every free movie site at once';
    renderAll();
    renderSites();
  }

  /* ---------------- rendering ---------------- */

  function renderAll() {
    const hasQuery = !!state.query;
    document.body.classList.toggle('has-query', hasQuery);
    els.quick.hidden = hasQuery;
    els.recent.hidden = hasQuery || readRecent().length === 0;
    els.toolbar.hidden = !hasQuery;
    els.errorPanel.hidden = !state.error;

    if (state.error) {
      els.errorText.textContent = state.error;
      els.results.textContent = '';
      els.empty.hidden = true;
      els.strip.hidden = true;
      els.statusLine.hidden = true;
      els.manual.hidden = true;
      return;
    }

    if (!hasQuery) {
      els.results.textContent = '';
      els.empty.hidden = true;
      els.strip.hidden = true;
      els.statusLine.hidden = true;
      els.manual.hidden = true;
      return;
    }

    if (state.loading) {
      els.empty.hidden = true;
      els.manual.hidden = true;
      els.strip.hidden = true;
      els.statusLine.hidden = false;
      const liveCount = state.allSources.filter(s => s.verified).length;
      const total = state.tryAll ? state.allSources.length : liveCount;
      const label = total > 1 ? 'sites' : 'site';
      els.statusText.innerHTML = `Searching <strong>${total || 'the'}</strong> ${state.tryAll ? label : 'live ' + label} for “<strong>${escapeHtml(state.query)}</strong>”…`;
      els.clearFilters.hidden = true;
      renderSkeletons();
      return;
    }

    const visible = getVisibleItems();
    const groups = state.group ? buildGroups(visible) : visible.map(toSingleGroup);
    const sorted = sortGroups(groups);

    renderSourceStrip();
    renderManual();
    renderStatus(visible);

    els.empty.hidden = sorted.length > 0;
    if (!sorted.length) {
      renderEmptyState(visible.length);
      els.results.textContent = '';
      return;
    }

    els.results.textContent = '';
    const frag = document.createDocumentFragment();
    sorted.forEach((group, i) => frag.append(renderCard(group, i)));
    els.results.append(frag);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getVisibleItems() {
    return state.items.filter(item =>
      (state.type === 'all' || item.type === state.type) &&
      !state.hiddenSources.has(item.source && item.source.id)
    );
  }

  function toSingleGroup(item) {
    return {
      key: item.url,
      title: item.title,
      year: item.year,
      type: item.type,
      poster: item.poster,
      quality: item.quality,
      sources: [{ ...item.source, url: item.url }],
      titleKey: titleKey(item.title),
      types: { [item.type]: 1 }
    };
  }

  function mergeGroup(target, extra) {
    for (const s of extra.sources) {
      if (!target.sources.some(x => x.id === s.id)) target.sources.push(s);
    }
    if (!target.poster && extra.poster) target.poster = extra.poster;
    if (!target.quality && extra.quality) target.quality = extra.quality;
    for (const [t, n] of Object.entries(extra.types)) target.types[t] = (target.types[t] || 0) + n;
  }

  function buildGroups(items) {
    // Cluster by normalized title first, then by year inside each title. This
    // keeps real remakes apart while folding the year-less / mistagged copies
    // that most scraped search pages produce.
    const byTitle = new Map();
    for (const item of items) {
      const tk = titleKey(item.title);
      if (!byTitle.has(tk)) byTitle.set(tk, new Map());
      const years = byTitle.get(tk);
      const yk = item.year || '';
      let group = years.get(yk);
      if (!group) {
        group = {
          key: `${tk}|${yk}`, title: item.title, year: item.year || null, type: item.type,
          poster: item.poster, quality: item.quality, sources: [],
          titleKey: tk, types: {}
        };
        years.set(yk, group);
      }
      if (!group.sources.some(s => s.id === item.source.id)) {
        group.sources.push({ ...item.source, url: item.url });
      }
      if (!group.poster && item.poster) group.poster = item.poster;
      if (!group.quality && item.quality) group.quality = item.quality;
      group.types[item.type] = (group.types[item.type] || 0) + 1;
    }

    const out = [];
    for (const years of byTitle.values()) {
      const clusters = [...years.values()];
      const dated = clusters.filter(g => g.year).sort((a, b) => b.sources.length - a.sources.length);
      const undated = clusters.filter(g => !g.year);
      if (!dated.length) {
        const base = undated.shift();
        undated.forEach(g => mergeGroup(base, g));
        out.push(base);
        continue;
      }
      const dominant = dated[0];
      // A one-source year is almost always a mis-tag; a well-supported second
      // year is likely a real remake, so keep it as its own card.
      for (const g of dated.slice(1)) {
        if (g.sources.length >= 2) out.push(g);
        else mergeGroup(dominant, g);
      }
      undated.forEach(g => mergeGroup(dominant, g));
      out.push(dominant);
    }

    return out.map(g => ({
      ...g,
      type: (g.types.tv || 0) > (g.types.movie || 0) ? 'tv' : 'movie'
    }));
  }

  function relevanceScore(group) {
    const q = normalizeText(state.query);
    const t = normalizeText(group.title);
    if (!q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.includes(q)) return 60;
    const tokens = q.split(' ').filter(Boolean);
    const hit = tokens.filter(tok => t.includes(tok)).length;
    return hit * 10;
  }

  function sortGroups(groups) {
    const arr = [...groups];
    const bySources = (a, b) => b.sources.length - a.sources.length;
    switch (state.sort) {
      case 'year':
        return arr.sort((a, b) => (b.year || 0) - (a.year || 0) || bySources(a, b) || a.title.localeCompare(b.title));
      case 'title':
        return arr.sort((a, b) => a.title.localeCompare(b.title));
      case 'relevance':
        return arr.sort((a, b) => relevanceScore(b) - relevanceScore(a) || bySources(a, b) || a.title.localeCompare(b.title));
      default: {
        // "Most sources" still pins an exact title match to the top, so a
        // spinoff with more mirrors cannot outrank the title you asked for.
        const exact = g => relevanceScore(g) >= 100 ? 1 : 0;
        return arr.sort((a, b) => exact(b) - exact(a) || bySources(a, b) || relevanceScore(b) - relevanceScore(a) || a.title.localeCompare(b.title));
      }
    }
  }

  function renderCard(group, index) {
    const card = document.createElement('article');
    card.className = 'card';
    card.style.animationDelay = `${Math.min(index, 20) * 18}ms`;

    const poster = document.createElement('div');
    poster.className = 'poster';

    const primary = group.sources[0];
    const link = document.createElement('a');
    link.href = primary ? primary.url : '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'poster-link';
    link.setAttribute('aria-label', `Open ${group.title} on ${primary ? primary.name : 'source'}`);

    if (group.poster) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.className = 'loading';
      img.src = `/poster?url=${encodeURIComponent(group.poster)}`;
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => {
        img.remove();
        poster.prepend(makeFallback(group.title));
      });
      link.append(img);
    } else {
      link.append(makeFallback(group.title));
    }

    const typeBadge = document.createElement('span');
    typeBadge.className = `badge type ${group.type}`;
    typeBadge.textContent = group.type === 'tv' ? 'TV' : 'Movie';

    link.append(typeBadge);

    if (group.sources.length > 1) {
      const count = document.createElement('span');
      count.className = 'badge count';
      count.textContent = `${group.sources.length} sites`;
      link.append(count);
    }

    if (group.quality) {
      const q = document.createElement('span');
      q.className = 'badge quality';
      q.textContent = group.quality;
      link.append(q);
    }

    const openIcon = document.createElement('span');
    openIcon.className = 'poster-open';
    openIcon.innerHTML = ICON.play;
    link.append(openIcon);
    poster.append(link);

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = group.title;
    title.title = group.title;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    if (group.year) {
      const y = document.createElement('span');
      y.textContent = group.year;
      meta.append(y);
    }
    if (group.sources.length > 1) {
      if (meta.childElementCount) meta.append(dotEl());
      const s = document.createElement('span');
      s.textContent = `${group.sources.length} sources`;
      meta.append(s);
    } else if (primary) {
      if (meta.childElementCount) meta.append(dotEl());
      const s = document.createElement('span');
      s.textContent = primary.host || primary.name;
      meta.append(s);
    }

    const list = document.createElement('div');
    list.className = 'source-list';
    const shown = state.expanded.has(group.key) ? group.sources.length : Math.min(group.sources.length, 4);
    group.sources.slice(0, shown).forEach(src => list.append(sourcePill(src)));
    if (group.sources.length > shown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'source-pill more';
      more.textContent = `+${group.sources.length - shown} more`;
      more.addEventListener('click', () => {
        state.expanded.add(group.key);
        renderResults();
      });
      list.append(more);
    } else if (state.expanded.has(group.key) && group.sources.length > 4) {
      const less = document.createElement('button');
      less.type = 'button';
      less.className = 'source-pill more';
      less.textContent = 'Show less';
      less.addEventListener('click', () => {
        state.expanded.delete(group.key);
        renderResults();
      });
      list.append(less);
    }

    body.append(title);
    if (meta.childElementCount) body.append(meta);
    body.append(list);
    card.append(poster, body);
    return card;
  }

  function makeFallback(title) {
    const fallback = document.createElement('div');
    fallback.className = 'poster-fallback';
    fallback.textContent = title;
    return fallback;
  }

  function dotEl() {
    const d = document.createElement('span');
    d.className = 'meta-dot';
    return d;
  }

  function sourcePill(src) {
    const a = document.createElement('a');
    a.className = 'source-pill';
    a.href = src.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = `Open on ${src.name} (${src.host || 'external site'})`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    a.append(dot, document.createTextNode(src.name));
    return a;
  }

  function renderSkeletons() {
    els.results.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 12; i++) {
      const card = document.createElement('div');
      card.className = 'skeleton';
      const poster = document.createElement('div');
      poster.className = 'poster';
      poster.append(Object.assign(document.createElement('div'), { className: 'poster-placeholder' }));
      const body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = '<div class="line"></div><div class="line short"></div>';
      card.append(poster, body);
      frag.append(card);
    }
    els.results.append(frag);
  }

  function renderResults() {
    if (!state.query) return;
    if (state.loading) return;
    const visible = getVisibleItems();
    const groups = state.group ? buildGroups(visible) : visible.map(toSingleGroup);
    const sorted = sortGroups(groups);
    renderStatus(visible);
    els.empty.hidden = sorted.length > 0;
    if (!sorted.length) {
      els.results.textContent = '';
      renderEmptyState(visible.length);
      return;
    }
    els.results.textContent = '';
    const frag = document.createDocumentFragment();
    sorted.forEach((group, i) => frag.append(renderCard(group, i)));
    els.results.append(frag);
    els.strip.hidden = false;
    els.manual.hidden = false;
    renderSourceStrip();
    renderManual();
  }

  function renderStatus(visible) {
    if (!state.stats) { els.statusLine.hidden = true; return; }
    els.statusLine.hidden = false;
    const titles = state.group ? buildGroups(visible).length : visible.length;
    const sitesWithResults = new Set(visible.map(i => i.source && i.source.id).filter(Boolean)).size;
    const seconds = (state.tookMs / 1000).toFixed(state.tookMs < 10000 ? 1 : 0);
    const failures = state.sources.filter(s => ['blocked', 'timeout', 'error'].includes(s.status)).length;
    els.clearFilters.hidden = state.hiddenSources.size === 0;

    if (!titles) {
      if (state.items.length) {
        els.statusText.innerHTML = `All <strong>${fmtCount(state.items.length)}</strong> results are hidden by the current filters`;
      } else {
        const answered = state.sources.filter(s => s.status === 'ok' || s.status === 'empty').length;
        els.statusText.innerHTML = `No matches across <strong>${answered}</strong> ${plural(answered, 'live site', 'live sites')} · ${seconds}s${state.cached ? ' · cached' : ''}`;
      }
      return;
    }

    const parts = [
      `<strong>${fmtCount(titles)}</strong> ${plural(titles, 'title', 'titles')}`,
      `across <strong>${sitesWithResults}</strong> ${plural(sitesWithResults, 'source', 'sources')}`,
      `${seconds}s${state.cached ? ' · cached' : ''}`
    ];
    if (failures) parts.push(`${failures} unreachable`);
    els.statusText.innerHTML = parts.join(' · ');
  }

  function renderEmptyState(visibleCount) {
    const filteredOut = state.items.length > 0 && visibleCount === 0;
    els.empty.hidden = false;
    if (filteredOut) {
      els.emptyTitle.textContent = 'Nothing matches these filters';
      els.emptyText.textContent = 'Every result is hidden by the type or source filters. Clear them to see the full list.';
      els.emptyRetry.textContent = 'Clear filters';
      els.emptyRetry.onclick = () => {
        state.hiddenSources.clear();
        state.type = 'all';
        $$('.seg', els.typeFilter).forEach(b => {
          const active = b.dataset.type === 'all';
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        renderResults();
        renderSourceStrip();
      };
      els.emptyTryAll.hidden = true;
    } else {
      els.emptyTitle.textContent = `No matches for “${state.query}”`;
      els.emptyText.textContent = state.tryAll
        ? 'None of the sites returned a match. Try a shorter title or check the spelling.'
        : 'The live sites did not return a match. Some sites render results in the browser — try enabling “Try all sites”, or use the direct search links below.';
      els.emptyRetry.textContent = 'Search again';
      els.emptyRetry.onclick = () => runSearch(state.query, { force: true });
      els.emptyTryAll.hidden = state.tryAll;
    }
  }

  function renderSourceStrip() {
    if (!state.sources.length) { els.strip.hidden = true; return; }
    els.strip.hidden = false;
    els.strip.textContent = '';

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'source-chip' + (state.hiddenSources.size ? '' : ' active');
    all.dataset.source = '*';
    all.setAttribute('aria-pressed', String(state.hiddenSources.size === 0));
    all.title = 'Show results from every source';
    all.innerHTML = '<span class="dot ok"></span>All sources';
    els.strip.append(all);

    const sorted = [...state.sources].sort((a, b) => {
      const rank = s => s.status === 'ok' ? 0 : s.status === 'empty' ? 1 : s.status === 'manual' ? 3 : 2;
      return rank(a) - rank(b) || b.count - a.count || a.name.localeCompare(b.name);
    });

    for (const src of sorted) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const hidden = state.hiddenSources.has(src.id);
      btn.className = 'source-chip' + (hidden ? ' off' : '');
      btn.dataset.source = src.id;
      btn.dataset.status = src.status;
      btn.setAttribute('aria-pressed', String(!hidden));
      btn.title = `${src.name}: ${statusLabel(src.status)}${src.count ? ` · ${src.count} results` : ''}${src.error ? ` · ${src.error}` : ''}`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = src.name;
      btn.append(dot, label);
      if (src.status === 'ok') {
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = src.count;
        btn.append(count);
      }
      els.strip.append(btn);
    }
  }

  function renderManual() {
    const manual = state.sources.filter(s =>
      s.status === 'manual' || ['blocked', 'timeout', 'error'].includes(s.status)
    );
    if (!manual.length || !state.query) {
      els.manual.hidden = true;
      return;
    }
    els.manual.hidden = false;
    els.manualGrid.textContent = '';
    const limit = state.manualExpanded ? manual.length : 12;
    manual.slice(0, limit).forEach(src => {
      const a = document.createElement('a');
      a.className = 'manual-link';
      const fallback = state.allSources.find(s => s.id === src.id)?.url || '#';
      a.href = src.hasSearch ? (src.searchUrl || fallback) : fallback;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = src.hasSearch ? `Search “${state.query}” on ${src.name}` : `Open ${src.name} (no direct search URL)`;
      const name = document.createElement('span');
      name.textContent = src.name;
      const icon = document.createElement('span');
      icon.innerHTML = ICON.external;
      a.append(name, icon.firstElementChild);
      els.manualGrid.append(a);
    });
    els.manualToggle.hidden = manual.length <= 12;
    els.manualToggle.textContent = state.manualExpanded ? 'Show less' : `Show all ${manual.length}`;
  }

  /* ---------------- recent searches ---------------- */

  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(LS_RECENT) || '[]');
      return Array.isArray(list) ? list.filter(x => typeof x === 'string').slice(0, 8) : [];
    } catch { return []; }
  }

  function saveRecent(query) {
    try {
      const list = readRecent().filter(x => x.toLowerCase() !== query.toLowerCase());
      list.unshift(query);
      localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, 8)));
    } catch {}
  }

  function renderRecent() {
    const list = readRecent();
    els.recentList.textContent = '';
    if (!list.length) { els.recent.hidden = true; return; }
    els.recent.hidden = !!state.query;
    for (const q of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.q = q;
      btn.textContent = q;
      els.recentList.append(btn);
    }
  }
})();
