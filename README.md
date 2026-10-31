# StreamFinder

One query. Every site in the [2026 BestFreeStreaming list](https://www.bestfreestreaming.org/). No accounts, no video hosting, no nonsense.

StreamFinder runs a search against the public search pages and APIs of the 52 sites in the list, plus an optional 42-site Arabic list from [re-3arabi](https://github.com/Abodabodd/re-3arabi), merges duplicate titles across sources, and gives you a direct link to every place a movie or show was found. Sites that build results in the browser are still one click away through their own search page.

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-3c873a) ![Dependencies](https://img.shields.io/badge/dependencies-0-blue) ![Sources](https://img.shields.io/badge/sources-94-ff4d6d)

---

## Quick start

**Windows**

1. Double-click `start.bat` — it starts the server and opens the page.
2. Double-click `stop.bat` (or close the server window) to stop it.

**Any platform**

```bash
cd streamfinder
npm start
```

Then open <http://localhost:8790>.

Change the port with an environment variable:

```powershell
$env:PORT=9000; npm start
```

Requires Node.js 18 or newer (uses the built-in `fetch`). There is nothing to install — the project has zero runtime dependencies.

---

## What you get

- **One search box, 24 live sources.** The English list contributes 17 live-search sites and the Arabic list adds 7. Searches run in parallel and usually finish in 3–6 seconds.
- **Merged results.** The same title found on many sites becomes one card with a source pill for each site, so you can pick the one that works for you.
- **Honest coverage.** Sites that block scraping or render results with JavaScript are labeled *Open on site* and get a direct search link instead of fake results.
- **Filters and sorting.** Movie/TV filter, source chips, grouping toggle, and sort by most sources, relevance, newest, or A–Z.
- **Poster proxy.** Posters are fetched through the local server, so images load even when the source site blocks hotlinking.
- **Local and private.** No analytics, no accounts. The server keeps only a short-lived in-memory search cache.
- **Works on mobile.** Responsive two-column grid and a compact search layout.

### Coverage at a glance

| Catalog | Entries | Live search | Open on site |
|---|---:|---:|---:|
| Non Arabic Sites (BestFreeStreaming) | **52** | **17** | **35** |
| Arabic Sites (re-3arabi) | **42** | **7** | **35** |
| Both | **94** | **24** | **70** |

Non-Arabic live-search sources: BingeBang, Zoechip, Reelix, Vexo, Nova, Cineruv, MovieNerds, Flixeo, HiMovies, MyFlixer, 2Flix, MoviesJoy, CornClick, HDToday, Movish, MooPlay, BoredFlix.

Arabic live-search sources: 5TV, Aflaam, CimaClub, Shahid4u, TopCinema, Tuktukcima, Tuniflix.

The rest either return a bot challenge, render their results client-side, or only expose a homepage. StreamFinder still links to their search page (or homepage when no search route exists), so every entry in the list is one click away. The *Try all sites* toggle also asks the direct-only sites for results when you want to try harder.

> Coverage changes constantly. Re-run the audit (below) if a site starts or stops working.

---

## How it works

```
Browser
  └─ GET /api/search?q=inception&catalog=non-arabic
       └─ server.js
            ├─ loadSources()          data/sources.json + data/sources-ar.json
            ├─ filter by catalog      non-arabic | arabic | both
            ├─ select verified sources
            ├─ runSourceSearch() × N  pool of 8, 8.5 s timeout each
            │    ├─ fetch the site's search URL
            │    ├─ parse: flixer | generic | json-ld | json API
            │    ├─ filter by query relevance
            │    └─ sanitize URL / poster / year / type
            ├─ merge + sort statuses
            └─ JSON response (gzip, 4-minute cache)
```

**Source registries.** `data/sources.json` is generated from the BestFreeStreaming page and then audited with three unrelated queries (`inception`, `the matrix`, `breaking bad`). A source only stays `verified` if at least two queries return genuinely relevant cards. `data/sources-ar.json` contains the 42 usable sites from the re-3arabi plugin repository; only endpoints that returned relevant live results are marked `verified`, and the rest keep a direct on-site search link. Navigation links, logos, and unrelated “trending” cards are discarded by the relevance filter.

**Parsers** (`lib/parse.js`)

- `flixer` — the common `film-poster` / `flw-item` card markup used by many sites.
- `generic` — anchors with media-looking URLs plus nearby titles and posters, with JSON-LD fallback.
- `json` — some sites expose a clean JSON search endpoint (BingeBang, Nova, Vexo, Cineruv, MovieNerds), which is faster and more reliable. For these, `siteSearch` keeps the “Search on site” link on the site itself instead of pointing at the API.

**Relevance** (`lib/search.js`) uses Unicode-aware normalization, so Arabic titles survive lowercasing and punctuation cleanup. It ignores stopwords and requires the long tokens of the query to appear in the title. This is what keeps “related” and “recommended” cards out of your results.

**Grouping** happens in the browser: titles are clustered by normalized title, then by year. A one-source year mismatch is treated as noise and folded in; two well-supported years are kept apart as likely remakes.

**Caching / limits**

- Search responses: 4 minutes, in memory.
- Posters: 1 hour, in memory.
- Rate limit: 120 requests per minute per client.
- Upstream body limit: 4 MB.

**Poster proxy safety.** `/poster` accepts only `http`/`https`, rejects localhost/private/link-local addresses and non-standard ports, allows image MIME types only, and caps images at 8 MB.

---

## API

All responses are JSON except `/poster`.

| Endpoint | Description |
|---|---|
| `GET /api/search?q=inception` | Search all verified sources in the default non-Arabic catalog. |
| `GET /api/search?q=inception&catalog=arabic` | Search the Arabic catalog (`non-arabic`, `arabic`, or `both`). |
| `GET /api/search?q=inception&tryAll=1` | Also query direct-only sites (slower). |
| `GET /api/search?q=inception&nocache=1` | Bypass the search cache. |
| `GET /api/search?q=inception&sources=bingebang,nova` | Limit to specific source IDs. |
| `GET /api/search?q=inception&sources=nova,vexo&batch=1` | Return only those sources' statuses. Used by the Cloudflare client in small batches. |
| `GET /api/sources` | The full source registry with status metadata. |
| `GET /api/health` | Uptime, source counts, cache sizes. |
| `GET /poster?url=https://…` | SSRF-guarded poster proxy. |

Example response shape:

```json
{
  "query": "inception",
  "catalog": "non-arabic",
  "tookMs": 3100,
  "total": 118,
  "results": [
    {
      "title": "Inception",
      "year": 2010,
      "type": "movie",
      "poster": "https://image.tmdb.org/…",
      "quality": "HD",
      "url": "https://zoechip.bz/movie/…",
      "source": { "id": "zoechip", "name": "Zoechip", "host": "zoechip.bz" }
    }
  ],
  "sources": [
    { "id": "zoechip", "name": "Zoechip", "status": "ok", "count": 2, "ms": 940 }
  ],
  "stats": { "searched": 17, "responded": 17, "withResults": 17, "manual": 34 }
}
```

Source statuses: `ok`, `empty`, `blocked`, `timeout`, `error`, `manual`.

---

## Project layout

```
streamfinder/
├─ server.js                 local HTTP server + shared route handlers
├─ api/
│  ├─ search.js              Vercel/serverless adapter: /api/search
│  ├─ sources.js             Vercel/serverless adapter: /api/sources
│  ├─ health.js              Vercel/serverless adapter: /api/health
│  └─ poster.js              Vercel/serverless adapter: /poster
├─ worker/
│  └─ index.js               Cloudflare Worker adapter: /api/* + /poster
├─ wrangler.toml             Cloudflare Worker + static asset config
├─ data/
│  ├─ sources.json           52-entry non-Arabic registry (hot-reloaded)
│  └─ sources-ar.json        42-entry Arabic registry
├─ lib/
│  ├─ parse.js               HTML / JSON-LD / JSON-API result parsers
│  └─ search.js              relevance, normalization, URL helpers
├─ public/
│  ├─ index.html             page shell
│  ├─ styles.css             dark cinematic UI
│  └─ app.js                 client state, grouping, rendering
├─ scripts/
│  ├─ audit-sources.js       multi-query source audit (authoritative)
│  └─ probe-sources.js       quick single-query probe / template discovery
├─ start.bat                 Windows launcher
├─ stop.bat                  stop whatever listens on port 8790
├─ render.yaml               Render blueprint (optional)
├─ vercel.json               Vercel function config
└─ package.json
```

---

## Put it online

GitHub Pages **cannot** host this project: the app is a Node server, not a static site, and `/api/search` plus `/poster` need a running process server-side.

GitHub stores the code; a host runs it. **Vercel** is the easiest free option that needs no credit card.

### 1. Put the code on GitHub

Create an empty repository on GitHub (do not add a README or license), then:

```bash
cd streamfinder
git init
git add .
git commit -m "Initial StreamFinder"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/streamfinder.git
git push -u origin main
```

Or with the GitHub CLI:

```bash
gh auth login
gh repo create streamfinder --public --source=. --remote=origin --push
```

### 2. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com), sign in with GitHub, and choose **Add New → Project**.
2. Import the `streamfinder` repository.
3. Leave the framework preset as **Other** and leave the build/output settings empty. Vercel serves `public/` automatically and turns `api/*.js` into serverless functions.
4. Click **Deploy**.
5. Open the generated URL, for example `https://streamfinder-xxxx.vercel.app`.

`vercel.json` sets a 60-second function limit for the slower “Try all sites” searches. No environment variables are required.

> Vercel’s free Hobby plan is for personal projects and does not require a card. Serverless instances do not stay warm, so the first search after a quiet period may be a little slower, and in-memory caches reset between instances.

### Deploy on Cloudflare Workers (optional)

`worker/index.js` and `wrangler.toml` are included for Cloudflare Workers with static assets. The Worker handles `/api/*` and `/poster`, while `public/` is served by Cloudflare’s asset layer.

```bash
npx wrangler login
npm run worker:deploy
```

If your existing Worker has a different name, change `name` in `wrangler.toml` first.

> **Cloudflare free plan limits:** Workers Free allows **50 outbound subrequests** and **10 ms of CPU time per invocation**. The browser splits searches into groups of three sources, so each request stays well under both limits. If you call the API directly on Cloudflare, pass `batch=1` with no more than three `sources` IDs per request. Vercel remains available if you prefer one request per search.

### Other Node hosts

- **Koyeb** — one free web service (card required for verification, not charged on the free tier). Connect the GitHub repo, use Node, start command `npm start`, and set `HOST=0.0.0.0`.
- **Render** — use the included `render.yaml` if your account still has the free web-service tier. Build `npm install`, start `npm start`, `HOST=0.0.0.0`.
- **Railway / Fly.io / Northflank** — work similarly, but usually require a card or have limited free credits.

Any host that runs a persistent Node process and provides a `PORT` environment variable will work. Free instances typically sleep after inactivity, so the first request can take 30–60 seconds. Scraping from a cloud IP may also trigger more bot challenges than running locally.

---

## Maintenance

Re-audit the registry after site changes:

```bash
npm run audit
```

This checks every source against three queries, promotes sources that return relevant results, demotes the rest, and rewrites `data/sources.json`. The running server picks up the file automatically (it watches the mtime), so no restart is needed.

Quick probe for a single query or new template:

```bash
npm run probe
```

`probe-sources.js` is a faster, single-query check. The multi-query audit is the authoritative one — a site that fails one query may still be useful.

To add a site manually:

```json
{
  "id": "example",
  "name": "Example",
  "url": "https://example.com",
  "origin": "https://example.com",
  "kind": "stream",
  "search": "https://example.com/search?q={q}",
  "searchTemplates": ["https://example.com/search?q={q}", "https://example.com/?s={q}"],
  "parser": "auto",
  "verified": false,
  "enabled": false,
  "note": "not audited"
}
```

Then run `npm run audit`. Arabic entries live in `data/sources-ar.json`, use `ar-` IDs, and are served through `?catalog=arabic`; they are kept out of the BestFreeStreaming audit so the English registry can be regenerated safely.

---

## Notes and limits

- **StreamFinder does not host, stream, or download video.** It reads public search pages and links out to third-party sites.
- Third-party sites change domains, markup, and anti-bot rules often. Expect coverage to drift; re-run the audit when results look stale.
- Direct-only sites may show a search box on their page even though StreamFinder cannot read the results server-side.
- These sites run ads. Use an ad-blocker and standard caution with pop-ups.
- Availability and legality vary by country. Check the rules where you live; this project is an index, not legal advice.
- Queries are cached in memory for four minutes and are not written to disk. There is no logging of search terms.

---

Built on the 2026 list from [BestFreeStreaming](https://www.bestfreestreaming.org/), with the Arabic catalog from [re-3arabi](https://github.com/Abodabodd/re-3arabi). Not affiliated with any of the indexed sites.
