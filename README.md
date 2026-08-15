# OpenRouter Providers

A fully static website that shows **every OpenRouter model with all of the
providers that serve it and each provider's pricing** — base list prices from
OpenRouter's documented API, plus real market (effective) prices when traffic
data exists. No AI backend; V1 is fully deterministic.

## How it works

```
GitHub Actions ──► scripts/fetch_data.py ──► data/*.json ──► static frontend (public/)
   (daily 03:30 UTC) ──► scripts/fetch_arena.js ──► data/arena_raw.json ─┘
                        └─► deploy to GitHub Pages
```

1. **`scripts/fetch_data.py`** fetches the model catalog, then for *each* model
   fetches its provider list with pricing (with retries/backoff for reliability)
   and merges everything into `data/models.json`.
2. **`scripts/fetch_arena.js`** (optional, runs rarely) scrapes the LMArena
   text leaderboard with headless Chrome into `data/arena_raw.json`; the
   fetcher maps those human-preference ranks onto models.
3. **`public/`** is a zero-build static frontend (HTML + JS + CSS) that reads
   the cached JSON and renders a searchable, sortable model browser with
   expandable per-provider pricing tables. Deployable as-is to any static host.

## Data sources (all public, no API key needed)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/models` | Documented API: model catalog (id, name, author, context, benchmarks) |
| `GET /api/v1/models/{id}/endpoints` | Documented API: **per-provider endpoints** — base `$/1M` in/out, provider tag, quantization, uptime, per-provider context |
| `GET /api/frontend/v1/stats/effective-pricing?permaslug=…` | Per-provider **effective (market) prices**, cache-hit rates, tokens served — only for models with traffic |
| `GET /api/frontend/v1/stats/endpoint?permaslug=…` | The model's **default endpoint** — what OpenRouter routes to by default (marked “default” in the UI) |
| `GET /api/frontend/v1/all-providers` | **Provider logos** — every provider ships an `icon.url` (hosted file or favicon) |
| `GET /api/frontend/v1/catalog/models` | Author metadata for **model logos** (`author_icon_uri` + display name) |

The fetcher runs the endpoints call for every model (reliable, documented,
covers ~all models) and enriches with effective pricing where it exists
(popular models often have *more* providers here than the endpoints listing).
Providers are merged by name and sorted cheapest-first using a 3:1
input:output blended cost. The default provider is highlighted separately —
for most models it is *not* the cheapest option, so the distinction matters.

**Logos**: provider rows carry the official icon from `all-providers` (~99%
coverage). Model rows use the author's favicon when the catalog exposes a
website, else OpenRouter's hosted `/images/icons/{name}.png`, and any miss
falls back to a colored letter avatar — so every row and card always has a
logo.

## The interface

The site is a light, paper-toned data desk — quiet greens and ochre,
serif-display headlines, mono numerals, and nothing decorative:

- **A simple bar chart** at the top, one per page, with filters — and a
  **source link** in the header pointing at the underlying data (OpenRouter
  pricing, Artificial Analysis, or the LMArena leaderboard):
  - **Browse** — **Best value** (Intelligence Index per `$/1M` at the best
    provider; free models rank first, shown as "free"), plus a **Min Intel**
    slider to exclude low-quality cheap models.
  - **AI tests** — Intelligence Index, same **Min Intel** slider.
  - **Show top N** — a bar-count slider on every page (defaults: 12 browse,
    15 elsewhere; once you set it, your number sticks on all pages).
- **The table** is the data layer: dense rows, tabular numerals, rank
  medals, expandable per model. The expanded model row pins below the top
  bar while you scroll its providers, and clicking the pinned bar collapses
  it again.
- **Expanding a model** shows one **tile per provider**, cheapest first:
  the provider's logo, its `$/1M` price (market vs base tagged), and two
  raw **uptime** meters — the 24h and 30m windows exactly as OpenRouter
  reports them. These are endpoint *availability* numbers, not quality
  scores: ~1/3 of provider rows sit below 99% and some at 0%, but they say
  nothing about output-quality drops or rate limiting.

## Comparison modes

The **Compare** switcher has two ranking views (plus the normal browse
table, which already carries the price column — cheapest blended `$/1M` is
the browse default sort). Each ranked view shows a `#` medal badge
(gold/silver/bronze for the top 3):

| Mode | Ranks by | Source | Coverage |
| --- | --- | --- | --- |
| **AI tests** | Artificial Analysis **Intelligence Index** (Intel/Coding/Agentic shown) | `GET /api/v1/models` → `benchmarks.artificial_analysis` | ~1/3 of models |
| **Arena** | LMArena human-preference **overall rank** (plus best category) | `scripts/fetch_arena.js` scrape of lmarena.ai | ~150 models |

Arena model ids use dashes + variant suffixes (`claude-opus-4-6-high`) where
OpenRouter uses dots (`anthropic/claude-opus-4.6`), so the fetcher matches on
a normalized key with progressive variant/date stripping (longest variant
first) — e.g. `gpt-5.6-sol-xhigh` → `openai/gpt-5.6-sol`. All matches are
verified to stay within the model family.

## Usage

```bash
# Full run — endpoints + effective-pricing enrichment (~2 requests per model)
python scripts/fetch_data.py

# Endpoints only (fewer requests, base list prices)
python scripts/fetch_data.py --skip-effective

# Refresh the LMArena human-preference ranks (needs Chrome; runs rarely)
node scripts/fetch_arena.js

# Tune concurrency / retries
python scripts/fetch_data.py --max-workers 12 --retries 3
```

Then serve the site (needs an HTTP server so `fetch()` can read the JSON):

```bash
python -m http.server 8000 --directory public
# open http://localhost:8000
```

The script writes `public/data/models.json`, so the whole `public/` folder is
self-contained and can be pushed to GitHub Pages / Netlify as-is.

## Automated refresh (GitHub Actions, free)

Live at **<https://chonkiboiwa.github.io/openrouter-providers/>** (repo:
<https://github.com/Chonkiboiwa/openrouter-providers>). The workflow in
`.github/workflows/refresh.yml` runs on GitHub's free tier:

- **Every 15 minutes** (`*/15 * * * *`): `fetch_data.py` — OpenRouter pricing,
  providers, uptime, and the AI benchmarks (they ride in OpenRouter's models
  API).
- **Daily 03:30 UTC** (`30 3 * * *`): additionally `fetch_arena.js` — fresh
  LMArena ranks via headless Chromium, committed back to the repo so the
  15-min builds keep the ranks.
- Each run uploads `public/` and deploys it to **GitHub Pages**.
- `workflow_dispatch` runs both jobs on demand from the Actions tab.

Run it locally the same way the workflow does:

```bash
python scripts/fetch_data.py          # 15-min job
node scripts/fetch_arena.js           # daily job (needs Chrome / playwright chromium)
```

## Scoring layer (archived)

The capability-per-dollar ranking layer has been **archived** to
`archive/scoring.py` while the project focuses on reliable provider/pricing
data. It's a standalone script that can be re-enabled later:

```bash
python archive/scoring.py    # reads data/models.json → writes data/rankings.json
```

## UI checks (screenshots + clipping detection)

The repo ships a Playwright-based checker (`scripts/check-ui.js`) that drives your
system Chrome (no browser download needed), screenshots every UI state
(default / expanded / search / sorted / narrow), and reports text clipping and
page overflow so cut text is caught without eyeballing pixels:

```bash
node scripts/check-ui.js          # needs the dev server on :8765
# screenshots → screenshots/  ·  overflow report printed to stdout
```

## Roadmap

- [ ] Latency / throughput columns from the endpoints API
- [ ] Cron scheduling + deployment (GitHub Actions + Pages)
- [ ] Re-enable the value-ranking layer once data is stable (`archive/scoring.py`)
