#!/usr/bin/env python3
"""
ARCHIVED — scoring layer (value rankings), set aside while the project focuses
on reliably fetching and displaying per-provider pricing.

Kept as a standalone script so it can be re-enabled later without archaeology:

    python archive/scoring.py          # reads data/models.json, writes data/rankings.json

The main fetch pipeline (scripts/fetch_data.py) intentionally writes NO scores.
This module only consumes the cached model data.
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")

IO_RATIO = 3.0  # input:output blend assumption for mixed workloads

VALUE_METRICS = ["value_intel", "value_coding", "value_agentic", "value_context"]


def blend(in_p, out_p):
    return (IO_RATIO * (in_p or 0) + (out_p or 0)) / (IO_RATIO + 1.0)


def percentile_rank(values, x):
    if not values:
        return 0.0
    below = sum(1 for v in values if v < x)
    equal = sum(1 for v in values if v == x)
    return (below + 0.5 * equal) / len(values) * 100.0


def main() -> int:
    src = os.path.join(DATA_DIR, "models.json")
    if not os.path.exists(src):
        print(f"data/models.json not found — run scripts/fetch_data.py first", file=sys.stderr)
        return 1

    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    models = data.get("models", [])
    meta = data.get("meta", {})

    rows = []
    for m in models:
        providers = m.get("providers") or []
        if not providers:
            continue
        # Cheapest provider by blended price (effective price when available,
        # else base) — the smart-buy view.
        def prov_cost(p):
            return blend(p.get("eff_in") or p.get("in"), p.get("eff_out") or p.get("out"))

        best = min(providers, key=prov_cost)
        blended = prov_cost(best)
        free = blended <= 0.0

        def value(score):
            if score is None or free:
                return None
            return round(score / blended, 2)

        rows.append(
            {
                "id": m["id"],
                "name": m.get("name"),
                "author": m.get("author"),
                "context": m.get("context") or 0,
                "blended": round(blended, 4),
                "best_provider": best.get("provider"),
                "best_in": best.get("eff_in") or best.get("in"),
                "best_out": best.get("eff_out") or best.get("out"),
                "provider_count": len(providers),
                "free": free,
                "intel": m.get("intel"),
                "coding": m.get("coding"),
                "agentic": m.get("agentic"),
                "value_intel": value(m.get("intel")),
                "value_coding": value(m.get("coding")),
                "value_agentic": value(m.get("agentic")),
                "value_context": round((m.get("context") or 0) / blended, 2) if not free and (m.get("context") or 0) > 0 else None,
            }
        )

    # Overall = mean percentile rank across capability value metrics.
    # Requires the core Artificial Analysis indexes (intel + coding) so that
    # models with sparse benchmark data can't game the ranking.
    scored = {metric: [r[metric] for r in rows if r[metric] is not None] for metric in ["value_intel", "value_coding", "value_agentic"]}
    for r in rows:
        if r["intel"] is None or r["coding"] is None:
            r["overall"] = None
            continue
        ranks = [percentile_rank(scored[metric], r[metric]) for metric in scored if r[metric] is not None and scored[metric]]
        r["overall"] = round(sum(ranks) / len(ranks), 1) if ranks else None

    rows.sort(key=lambda r: (r["overall"] is None, -(r["overall"] or 0)))

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": "ARCHIVED scoring layer — value rankings are currently not part of the live site.",
        "source_meta": meta,
        "stats": {
            "models_scored": len(rows),
            "models_with_overall": sum(1 for r in rows if r["overall"] is not None),
        },
    }
    with open(os.path.join(DATA_DIR, "rankings.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": payload, "rankings": rows}, f, indent=1)
    print(f"Wrote data/rankings.json ({len(rows)} models, {payload['stats']['models_with_overall']} with overall score)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
