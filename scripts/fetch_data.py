#!/usr/bin/env python3
"""
OpenRouter model + per-provider pricing fetcher.

For every model, fetches the full list of providers that serve it, with each
provider's base pricing (documented endpoints API), its real market (effective)
pricing when available, the default route, and logos (provider icons from the
public all-providers API, author logos via catalog metadata).

    python scripts/fetch_data.py                  # full run
    python scripts/fetch_data.py --skip-effective  # endpoints only (faster)

Outputs:
    data/models.json           — models, each with a providers[] array
    public/data/models.json    — copy for the static site
    data/meta.json             — fetch timestamp + stats
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://openrouter.ai"
MODELS_URL = f"{BASE}/api/v1/models"
ENDPOINTS_URL = f"{BASE}/api/v1/models/{{id}}/endpoints"
EFFECTIVE_URL = f"{BASE}/api/frontend/v1/stats/effective-pricing?permaslug={{slug}}"
DEFAULT_ENDPOINT_URL = f"{BASE}/api/frontend/v1/stats/endpoint?permaslug={{slug}}&variant=standard"
CATALOG_URL = f"{BASE}/api/frontend/v1/catalog/models"
PROVIDERS_URL = f"{BASE}/api/frontend/v1/all-providers"

IO_RATIO = 3.0  # input:output blend assumption used for sorting/best price

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")

# ── LMArena (arena.ai) human-preference ranks ────────────────────────────
# The leaderboard is scraped by scripts/fetch_arena.js into data/arena_raw.json
# (headless Chrome — the table is client-rendered behind a CF challenge).
# Arena model ids use dashes + variant suffixes where OpenRouter uses dots
# (claude-opus-4-6-high vs anthropic/claude-opus-4.6), so we match on a
# normalized key with progressive suffix stripping, longest variant first.

_ARENA_VARIANTS = sorted(
    [
        "high", "low", "medium", "thinking", "lite", "max", "flash", "turbo",
        "preview", "xhigh", "xlow", "latest", "sol", "terra", "chat", "instant",
        "exp", "mini", "nano", "reasoning", "instruct", "small", "large", "plus",
        "ultra", "beta", "32k", "128k", "256k", "expanded", "multi-agent", "multiagent",
    ],
    key=len,
    reverse=True,
)


def _norm(s: str) -> str:
    s = (s or "").lower().strip()
    s = re.sub(r"\(.*?\)", "", s)  # drop (xHigh) etc.
    return re.sub(r"[^a-z0-9]+", "", s)  # alnum only — dashes AND dots


def _arena_stripped_keys(aid: str) -> list[str]:
    """Progressive stripped keys: keep the longest preserved form first so a
    match never strips the identity itself (e.g. gpt-5.6-sol keeps 'sol')."""
    s = _norm(aid)
    s = re.sub(r"20\d{6}", "", s)  # dates like 20260210
    keys = [s]
    prev = None
    while s and s != prev:
        prev = s
        for suf in _ARENA_VARIANTS:
            if s.endswith(suf) and len(s) > len(suf) + 2:
                s = s[: -len(suf)]
                keys.append(s)
                break
    return keys


def load_arena(path: str | None = None) -> dict[str, dict]:
    """Load data/arena_raw.json (if present) → {normalized key: arena entry}."""
    path = path or os.path.join(DATA_DIR, "arena_raw.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, dict] = {}
    for entry in raw:
        aid = entry.get("arena_id") or ""
        for key in _arena_stripped_keys(aid):
            out.setdefault(key, entry)
    return out


def fetch_json(url: str, timeout: int = 30, retries: int = 3):
    """GET a URL as JSON with retries + backoff. Raises on persistent failure."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "openrouter-pricing-browser/1.0", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(0.5 * (2 ** attempt))
    raise last_err


def to_money(value) -> float:
    """Per-token price string → $ per 1M tokens. Negative (dynamic) → 0."""
    if value is None:
        return 0.0
    try:
        return max(float(value) * 1_000_000.0, 0.0)
    except (TypeError, ValueError):
        return 0.0


def absolutize(url: str) -> str:
    """Prefix relative asset URLs (e.g. /images/icons/X.webp) with the host."""
    if not url:
        return url
    return url if url.startswith("http") else BASE + url


def normalize_provider(name: str) -> str:
    """'DeepInfra (Turbo)' -> 'deepinfra' for matching across APIs."""
    if not name:
        return ""
    return name.split("(")[0].strip().lower()


def fetch_endpoints(model_id: str) -> list[dict]:
    """Per-provider base pricing + metadata for one model (documented API)."""
    try:
        data = fetch_json(ENDPOINTS_URL.format(id=urllib.parse.quote(model_id, safe="/")), timeout=20)
    except Exception:
        return []
    eps = data.get("data") or {}
    return eps.get("endpoints") or []


def fetch_default_endpoint(model_id: str, canonical_slug: str) -> dict | None:
    """The endpoint OpenRouter routes to by default for a model (first item)."""
    for slug in (model_id, canonical_slug):
        if not slug:
            continue
        try:
            data = fetch_json(DEFAULT_ENDPOINT_URL.format(slug=urllib.parse.quote(slug, safe="/")), timeout=20)
        except Exception:
            continue
        eps = data.get("data") or []
        if eps:
            return eps[0]
    return None


def fetch_effective(model_id: str, canonical_slug: str) -> dict | None:
    """Per-provider effective (real market) pricing for one model, or None."""
    slug = canonical_slug or model_id
    try:
        data = fetch_json(EFFECTIVE_URL.format(slug=urllib.parse.quote(slug, safe="/")), timeout=20)
    except Exception:
        return None
    d = data.get("data") or {}
    summaries = d.get("providerSummaries") or []
    if not summaries:
        return None
    return {
        "weightedInputPrice": d.get("weightedInputPrice"),
        "weightedOutputPrice": d.get("weightedOutputPrice"),
        "providers": [
            {
                "name": s.get("providerName"),
                "eff_in": s.get("effectiveInputPrice"),
                "eff_out": s.get("effectiveOutputPrice"),
                "cache_hit_rate": s.get("cacheHitRate"),
                "total_tokens": s.get("totalTokens"),
            }
            for s in summaries
        ],
    }


def fetch_provider_icons() -> dict[str, str]:
    """Map normalized provider name -> icon URL from the public all-providers API."""
    try:
        data = fetch_json(PROVIDERS_URL, timeout=30)
    except Exception:
        return {}
    out = {}
    for p in data.get("data") or []:
        icon = (p.get("icon") or {}).get("url")
        if not icon:
            continue
        url = absolutize(icon)
        for key in (p.get("name"), p.get("slug"), p.get("displayName")):
            if key:
                out[normalize_provider(key)] = url
    return out


def fetch_author_meta() -> dict[str, dict]:
    """slug -> {author_display, author_icon} from the catalog (one request)."""
    try:
        data = fetch_json(CATALOG_URL, timeout=60)
    except Exception:
        return {}
    out = {}
    for e in data.get("data") or []:
        slug = e.get("slug")
        if not slug:
            continue
        out[slug] = {
            "author_display": e.get("author_display_name") or e.get("author"),
            "author_icon": e.get("author_icon_uri"),  # website URL when present
        }
    return out


def build_providers(endpoints: list[dict], effective: dict | None, provider_icons: dict[str, str]) -> list[dict]:
    """Merge endpoint (base) rows with effective (market) prices by provider."""
    rows = []
    eff_by_name = {}
    for p in (effective or {}).get("providers", []):
        eff_by_name.setdefault(normalize_provider(p.get("name")), []).append(p)

    for ep in endpoints:
        pricing = ep.get("pricing") or {}
        base_in = to_money(pricing.get("prompt"))
        base_out = to_money(pricing.get("completion"))
        provider = ep.get("provider_name") or "Unknown"

        eff = None
        matches = eff_by_name.get(normalize_provider(provider))
        if matches:
            eff = matches[0]

        rows.append(
            {
                "provider": provider,
                "tag": ep.get("tag"),
                "model_id": ep.get("model_id"),
                "icon": provider_icons.get(normalize_provider(provider)),
                "in": round(base_in, 4),
                "out": round(base_out, 4),
                "eff_in": round(eff["eff_in"], 4) if eff and eff.get("eff_in") is not None else None,
                "eff_out": round(eff["eff_out"], 4) if eff and eff.get("eff_out") is not None else None,
                "cache_hit_rate": eff.get("cache_hit_rate") if eff else None,
                "total_tokens": eff.get("total_tokens") if eff else None,
                "context": ep.get("context_length") or 0,
                "quantization": ep.get("quantization"),
                "uptime_1d": ep.get("uptime_last_1d"),
                "uptime_30m": ep.get("uptime_last_30m"),
                "latency_30m": ep.get("latency_last_30m"),
                "is_free": bool(ep.get("is_free")) or (base_in <= 0 and base_out <= 0),
            }
        )

    # Effective-only providers (traffic data exists but no endpoint listing):
    # append with effective prices only.
    known = {normalize_provider(r["provider"]) for r in rows}
    for p in (effective or {}).get("providers", []):
        if normalize_provider(p.get("name")) in known:
            continue
        rows.append(
            {
                "provider": p.get("name"),
                "tag": None,
                "model_id": None,
                "icon": provider_icons.get(normalize_provider(p.get("name"))),
                "in": None,
                "out": None,
                "eff_in": round(p.get("eff_in") or 0, 4),
                "eff_out": round(p.get("eff_out") or 0, 4),
                "cache_hit_rate": p.get("cache_hit_rate"),
                "total_tokens": p.get("total_tokens"),
                "context": 0,
                "quantization": None,
                "uptime_1d": None,
                "uptime_30m": None,
                "latency_30m": None,
                "is_free": False,
            }
        )

    def cost(r):
        return (IO_RATIO * (r.get("eff_in") if r.get("eff_in") is not None else r.get("in") or 0)
                + (r.get("eff_out") if r.get("eff_out") is not None else r.get("out") or 0)) / (IO_RATIO + 1.0)

    rows.sort(key=cost)
    return rows


def build_models(
    models: list[dict],
    endpoints: dict[str, list[dict]],
    effective: dict[str, dict],
    default_endpoints: dict[str, dict],
    provider_icons: dict[str, str],
    author_meta: dict[str, dict],
    arena: dict[str, dict] | None = None,
) -> list[dict]:
    arena = arena or {}
    out = []
    for m in models:
        providers = build_providers(endpoints.get(m["id"], []), effective.get(m["id"]), provider_icons)
        am = author_meta.get(m["id"]) or {}

        # Mark the default (system) provider — what OpenRouter routes to by
        # default — by matching the endpoint the model page reports.
        def_ep = default_endpoints.get(m["id"])
        default_provider = None
        if def_ep:
            def_name = normalize_provider(def_ep.get("provider_name") or def_ep.get("name") or "")
            for p in providers:
                if normalize_provider(p["provider"]) == def_name:
                    p["is_default"] = True
                    default_provider = p["provider"]
                    break
            if default_provider is None:
                default_provider = def_ep.get("provider_name") or (def_ep.get("name") or "").split(" | ")[0]

        aa = (m.get("benchmarks") or {}).get("artificial_analysis") or {}

        # LMArena human-preference rank (overall + per-category), when mapped
        arena_entry = None
        for key in _arena_stripped_keys(m["id"].split("/")[-1]):
            if key in arena:
                arena_entry = arena[key]
                break
        if arena_entry is None:
            for key in _arena_stripped_keys(m.get("name") or ""):
                if key in arena:
                    arena_entry = arena[key]
                    break
        arena_cats = {}
        if arena_entry:
            for cat in ("overall", "expert", "hard", "coding", "math", "creative", "instruction", "longer"):
                if arena_entry.get(cat) is not None:
                    arena_cats[cat] = arena_entry[cat]

        out.append(
            {
                "id": m["id"],
                "canonical_slug": m.get("canonical_slug"),
                "name": m.get("name"),
                "author": m.get("author"),
                "author_display": am.get("author_display") or (m.get("name") or "").split(":")[0],
                "author_icon": am.get("author_icon"),  # website URL, or None
                "context": m.get("context_length") or 0,
                "intel": aa.get("intelligence_index"),
                "coding": aa.get("coding_index"),
                "agentic": aa.get("agentic_index"),
                "arena_rank": arena_cats.get("overall"),
                "arena": arena_cats or None,
                "default_provider": default_provider,
                "provider_count": len(providers),
                "providers": providers,
            }
        )
    out.sort(key=lambda m: -m["provider_count"])
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch OpenRouter models with per-provider pricing.")
    parser.add_argument("--skip-effective", action="store_true", help="Skip effective-pricing enrichment (endpoints only).")
    parser.add_argument("--max-workers", type=int, default=8, help="Concurrency for per-model requests (default 8).")
    parser.add_argument("--retries", type=int, default=3, help="Retries per request (default 3).")
    args = parser.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()

    print(f"[1/4] Fetching model catalog from {MODELS_URL} ...")
    catalog = fetch_json(MODELS_URL, retries=args.retries)
    models = catalog.get("data") or []
    print(f"      {len(models)} models")

    print("[1/4] Fetching author metadata + provider icons ...")
    author_meta = fetch_author_meta()
    provider_icons = fetch_provider_icons()
    print(f"      {len(author_meta)} author entries, {len(provider_icons)} provider icons")

    print(f"[2/4] Fetching per-model providers ({args.max_workers} workers) ...")
    ids = [m["id"] for m in models]

    def fetch_one(model_id: str):
        eps = fetch_endpoints(model_id)
        m = next((x for x in models if x["id"] == model_id), None)
        canonical = (m or {}).get("canonical_slug")
        def_ep = fetch_default_endpoint(model_id, canonical)
        eff = None
        if not args.skip_effective:
            eff = fetch_effective(model_id, canonical)
        return model_id, eps, def_ep, eff

    endpoints: dict[str, list[dict]] = {}
    default_endpoints: dict[str, dict] = {}
    effective: dict[str, dict] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as ex:
        for model_id, eps, def_ep, eff in ex.map(fetch_one, ids):
            if eps:
                endpoints[model_id] = eps
            if def_ep:
                default_endpoints[model_id] = def_ep
            if eff:
                effective[model_id] = eff
            done += 1
            if done % 50 == 0 or done == len(ids):
                print(f"      {done}/{len(ids)} fetched")
    print(f"      endpoints for {len(endpoints)}/{len(models)} models"
          + f", defaults for {len(default_endpoints)}"
          + (f", effective for {len(effective)}" if not args.skip_effective else ""))

    print("[3/4] Building cache ...")
    arena = load_arena()
    print(f"      arena leaderboard: {len(arena)} matched keys")
    rows = build_models(models, endpoints, effective, default_endpoints, provider_icons, author_meta, arena)
    with_arena = sum(1 for m in rows if m.get("arena_rank"))
    with_providers = sum(1 for m in rows if m["provider_count"] > 0)
    total_providers = sum(m["provider_count"] for m in rows)
    providers_with_icons = sum(1 for m in rows for p in m["providers"] if p.get("icon"))
    with_default = sum(1 for m in rows if m.get("default_provider"))

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": {
            "models": MODELS_URL,
            "endpoints": ENDPOINTS_URL,
            "effective_pricing": EFFECTIVE_URL,
            "default_endpoint": DEFAULT_ENDPOINT_URL,
            "providers_icons": PROVIDERS_URL,
            "author_meta": CATALOG_URL,
            "arena": "lmarena.ai/leaderboard (scripts/fetch_arena.js)",
        },
        "stats": {
            "models_total": len(rows),
            "models_with_providers": with_providers,
            "provider_rows_total": total_providers,
            "providers_with_icons": providers_with_icons,
            "models_with_default": with_default,
            "models_with_effective": len(effective),
            "models_with_arena": with_arena,
            "effective_enabled": not args.skip_effective,
            "fetch_seconds": round(time.time() - t0, 1),
        },
    }

    with open(os.path.join(DATA_DIR, "models.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": payload, "models": rows}, f, indent=1)
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    public_data = os.path.join(ROOT, "public", "data")
    os.makedirs(public_data, exist_ok=True)
    with open(os.path.join(public_data, "models.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": payload, "models": rows}, f, indent=1)

    print(f"Wrote data/models.json, data/meta.json, public/data/models.json ({time.time() - t0:.1f}s)")
    print(f"Stats: {len(rows)} models | {with_providers} with providers | {total_providers} provider rows ({providers_with_icons} with icons) | {with_default} with default provider | {len(effective)} with effective pricing | {with_arena} with arena rank")
    return 0


if __name__ == "__main__":
    sys.exit(main())
