/* OpenRouter Providers — static frontend. Reads data/models.json.
   One page, three sections:
     1. Podium — the top-3 overall models as big tiles (click → providers)
     2. Chart — a bar chart re-ranked live by the tabs (Overall / AI test /
        Arena / Price)
     3. Rows — the dense model list, ranked by the active tab, click a row
        to expand its providers. */
"use strict";

const IO_RATIO = 3.0;

/* the chart + rows rank by the selected tab */
const TABS = {
  overall: {
    label: "Overall",
    note: "equal-weight blend of value, AI-test, and arena scores",
    filter: (r) => r._scores && r._scores.overall != null,
    sort: podiumSort,
    metricKey: "overall",
  },
  ai: {
    label: "AI test",
    note: "Intelligence Index, highest first",
    filter: (r) => r.intel != null,
    sort: (a, b) => b.intel - a.intel,
    metricKey: "intel",
  },
  arena: {
    label: "Arena",
    note: "LMArena human-preference votes, #1 = most preferred",
    filter: (r) => r.arena_rank != null,
    sort: (a, b) => a.arena_rank - b.arena_rank,
    metricKey: "arena",
  },
  price: {
    label: "Price",
    note: "cheapest blended $/1M at the best provider, free first",
    filter: (r) => isFinite(bestCost(r)),
    sort: (a, b) => bestCost(a) - bestCost(b),
    metricKey: "best",
  },
};

/* Podium ranking: overall desc, then more pillars wins (a model ranked on
   all three beats a tie on two), then value, then intel. */
function podiumSort(a, b) {
  const sa = a._scores || {}, sb = b._scores || {};
  if (sb.overall !== sa.overall) return sb.overall - sa.overall;
  if ((sb.pillars || 0) !== (sa.pillars || 0)) return (sb.pillars || 0) - (sa.pillars || 0);
  if ((sb.value || 0) !== (sa.value || 0)) return (sb.value || 0) - (sa.value || 0);
  return (sb.ai || 0) - (sa.ai || 0);
}

let state = {
  rows: [],
  search: "",
  tab: "overall", // overall | ai | arena | price — drives the chart + rows
  expanded: new Set(), // rows / podium tiles whose providers are shown
  minIntel: 50, // default filter: only models with Intel Index >= 50
  topN: 20, // how many bars the chart shows (user-tunable)
};

/* ── data helpers ─────────────────────────────────────────────────────── */

function providerCost(p) {
  const inP = p.eff_in != null ? p.eff_in : p.in != null ? p.in : Infinity;
  const outP = p.eff_out != null ? p.eff_out : p.out != null ? p.out : Infinity;
  if (!isFinite(inP) || !isFinite(outP)) return Infinity;
  return (IO_RATIO * inP + outP) / (IO_RATIO + 1);
}

function bestProvider(r) {
  if (!r.providers || !r.providers.length) return null;
  return r.providers.reduce((a, b) => (providerCost(b) < providerCost(a) ? b : a));
}

function bestCost(r) {
  const b = bestProvider(r);
  return b ? providerCost(b) : Infinity;
}

function provPrice(p) {
  return p.eff_in != null ? [p.eff_in, p.eff_out] : [p.in, p.out];
}

/* ── formatters ───────────────────────────────────────────────────────── */

function fmtMoney(v) {
  if (v == null || isNaN(v)) return "—";
  if (v === 0) return "Free";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtNum(v) {
  if (v == null || isNaN(v)) return "—";
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── logos ────────────────────────────────────────────────────────────── */

const AVATAR_HUES = [150, 42, 210, 330, 95, 24, 262, 4]; // green, amber, blue, pink, lime, orange, violet, red

function hashHue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

function avatarMarkup(name, cls) {
  const letter = (String(name || "?")).trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar ${cls}" style="--h:${hashHue(name)}">${escapeHtml(letter)}</span>`;
}

/* Logo inside a rounded tile; the image fades out toward the tile's edges
   (mask) and blends into the tile background. On load failure the whole
   tile is replaced by a letter avatar. */
function iconImg(src, name, cls) {
  const fallback = escapeHtml(avatarMarkup(name, cls));
  return `<span class="logo-tile ${cls}"><img src="${src}" alt="" loading="lazy" data-fallback="${fallback}" onerror="__imgFallback(this)"></span>`;
}

function __imgFallback(el) {
  const tile = el.closest(".logo-tile");
  const fb = el.dataset.fallback || "";
  if (tile) tile.outerHTML = fb;
  else el.outerHTML = fb;
}

function modelIcon(r) {
  const disp = r.author_display || r.author || "?";
  let src;
  if (r.author_icon && /^https?:\/\//.test(r.author_icon)) {
    // Author website → favicon service (matches OpenRouter's own rendering).
    src = "https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url="
      + encodeURIComponent(r.author_icon) + "&size=128";
  } else {
    // Try OpenRouter's hosted author icons; 404s fall back to an avatar.
    src = "https://openrouter.ai/images/icons/" + encodeURIComponent(disp.replace(/\s+/g, "")) + ".png";
  }
  return iconImg(src, disp, "micon");
}

function providerIcon(p) {
  return p.icon ? iconImg(p.icon, p.provider, "picon") : avatarMarkup(p.provider, "picon");
}

/* ── header ───────────────────────────────────────────────────────────── */

function formatAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `${m} min${m === 1 ? "" : "s"} ago`;
  }
  if (s < 86400) {
    const h = Math.round(s / 3600);
    return `${h} hr${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(s / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

let _agoTimer = null;
/* Relative "updated X ago" everywhere, refreshed every minute. The absolute
   timestamp rides along in the title tooltip. */
function startAgoTimer(meta) {
  const update = () => {
    const ago = formatAgo(meta && meta.generated_at);
    const abs = meta && meta.generated_at ? new Date(meta.generated_at).toLocaleString() : "";
    const up = document.getElementById("updated");
    if (up) {
      up.textContent = `updated ${ago}`;
      up.title = abs;
    }
    const fu = document.getElementById("footerUpdated");
    if (fu) {
      fu.textContent = ago;
      fu.title = abs;
    }
    const statB = document.querySelector("#stats .stat.updated b");
    if (statB) {
      statB.textContent = ago;
      statB.title = abs;
    }
  };
  update();
  clearInterval(_agoTimer);
  _agoTimer = setInterval(update, 60000);
}

function renderStats(meta) {
  const s = meta.stats || {};
  const el = document.getElementById("stats");
  if (el) {
    const items = [
      { b: (s.models_total ?? "?").toLocaleString(), label: "models" },
      { b: (s.provider_rows_total ?? "?").toLocaleString(), label: "provider listings" },
      { b: (s.models_with_effective ?? "?").toLocaleString(), label: "with market prices" },
      { b: formatAgo(meta && meta.generated_at), label: "updated", updated: true },
    ];
    el.innerHTML = items
      .map((it) => `<div class="stat${it.updated ? " updated" : ""}"><b>${escapeHtml(it.b)}</b><span>${it.label}</span></div>`)
      .join("");
  }
  const cs = document.getElementById("chartStats");
  if (cs) {
    cs.innerHTML =
      `<b>${(s.models_total ?? "?").toLocaleString()}</b> models · `
      + `<b>${(s.provider_rows_total ?? "?").toLocaleString()}</b> listings · `
      + `<b>${(s.models_with_arena ?? "?").toLocaleString()}</b> arena-ranked`;
  }
  startAgoTimer(meta);
}

/* ── chart helpers ────────────────────────────────────────────────────── */

/* per-tab data sources, linked in the chart header */
const SOURCE_LINKS = {
  openrouter: '<a href="https://openrouter.ai/models" target="_blank" rel="noopener">OpenRouter</a>',
  aa: '<a href="https://artificialanalysis.ai/models" target="_blank" rel="noopener">Artificial Analysis</a>',
  lmarena: '<a href="https://lmarena.ai/leaderboard" target="_blank" rel="noopener">LMArena</a>',
};

function setChartSource(elId, html) {
  const el = document.getElementById(elId);
  if (el) el.innerHTML = `source: ${html}`;
}

function shortName(r) {
  return (r.name || r.id).split(":").pop().trim().replace(/ \(.*?\)/, "").slice(0, 24);
}

/* bang-for-buck: Intelligence Index per blended $/1M, at the best provider.
   Free models are infinite value — they sort first, shown as "free". */
function valueOf(r) {
  const c = bestCost(r);
  if (!isFinite(c) || c <= 0) return Infinity;
  return r.intel / c;
}

function fmtValue(v) {
  if (!isFinite(v)) return "free";
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

/* ── scoring ────────────────────────────────────────────────────────────
   Three pillars, each normalized to 0–100 with the best model at 100:
     value = bang-for-buck (Intel per blended $/1M at the best provider;
             free models are unbeatable → 100)
     ai    = Intelligence Index percentile
     arena = LMArena rank percentile (#1 → 100)
   Overall = equal-weight mean of the pillars a model actually has
   (missing pillars drop out of the average). Only models with ≥2
   pillars get an overall score, so the podium is never decided by
   price alone. */
function computeScores() {
  const rows = state.rows;
  const byIntel = rows.filter((r) => r.intel != null).sort((a, b) => b.intel - a.intel);
  const byArena = rows.filter((r) => r.arena_rank != null).sort((a, b) => a.arena_rank - b.arena_rank);
  const byValue = rows.filter((r) => r.intel != null && isFinite(bestCost(r))).sort((a, b) => valueOf(b) - valueOf(a));
  const pct = (arr, r) => {
    const i = arr.indexOf(r);
    if (i < 0 || arr.length < 2) return null;
    return (100 * (arr.length - 1 - i)) / (arr.length - 1);
  };
  const intelPct = new Map(byIntel.map((r) => [r.id, pct(byIntel, r)]));
  const arenaPct = new Map(byArena.map((r) => [r.id, pct(byArena, r)]));
  const valuePct = new Map(byValue.map((r) => [r.id, pct(byValue, r)]));
  for (const r of rows) {
    const free = r.providers && r.providers.some((p) => p.is_free);
    const value = free ? 100 : valuePct.get(r.id);
    const ai = intelPct.get(r.id);
    const arena = arenaPct.get(r.id);
    const pillars = [value, ai, arena].filter((v) => v != null);
    r._aiRank = ai != null ? byIntel.indexOf(r) + 1 : null;
    r._scores = {
      pillars: pillars.length,
      value: value != null ? Math.round(value) : null,
      ai: ai != null ? Math.round(ai) : null,
      arena: arena != null ? Math.round(arena) : null,
      overall: pillars.length >= 2 ? Math.round(pillars.reduce((a, b) => a + b, 0) / pillars.length) : null,
    };
  }
}

const passesIntel = (r) => state.minIntel === 0 || (r.intel != null && r.intel >= state.minIntel);

/* ── podium — the top-3 overall, big tiles ────────────────────────────── */

function pbar(label, val) {
  if (val == null) {
    return `<div class="pbar"><span class="plabel">${label}</span><span class="ptrack"><i class="pfill none"></i></span><span class="pval none">—</span></div>`;
  }
  return `<div class="pbar"><span class="plabel">${label}</span><span class="ptrack"><i class="pfill" style="width:${Math.min(100, Math.max(0, val))}%"></i></span><span class="pval">${val}</span></div>`;
}

function tileFoot(r) {
  const b = bestProvider(r);
  const price = b
    ? `${fmtMoney(provPrice(b)[0])} / ${fmtMoney(provPrice(b)[1])} <em>via ${escapeHtml(b.provider)}</em>`
    : '<span class="none">—</span>';
  const ranks = [
    r.arena_rank != null ? `Arena #${r.arena_rank}` : null,
    r._aiRank != null ? `AI #${r._aiRank}` : null,
  ].filter(Boolean).join(" · ");
  return `<span class="price">${price}</span>${ranks ? `<span class="pranks">${ranks}</span>` : ""}`;
}

function scoreBars(r) {
  const s = r._scores || {};
  return `${pbar("Value", s.value)}${pbar("AI test", s.ai)}${pbar("Arena", s.arena)}`;
}

function renderPodium() {
  const el = document.getElementById("podium");
  if (!el) return;
  setChartSource("podiumSource", `${SOURCE_LINKS.openrouter} prices · ${SOURCE_LINKS.aa} intel · ${SOURCE_LINKS.lmarena} arena`);
  const top3 = state.rows
    .filter((r) => passesIntel(r) && r._scores && r._scores.overall != null)
    .sort(podiumSort)
    .slice(0, 3);
  if (!top3.length) {
    el.innerHTML = '<p class="empty">No models qualify for the podium yet — try lowering Min Intel.</p>';
    return;
  }
  const medals = ["gold", "silver", "bronze"];
  el.innerHTML =
    '<div class="podium">' +
    top3.map((r, i) => {
      const s = r._scores || {};
      const open = state.expanded.has(r.id);
      return `<article class="ptile m${i + 1}${open ? " open" : ""}" data-id="${escapeHtml(r.id)}" title="Click for providers">
      <span class="pmedal ${medals[i]}">#${i + 1}</span>
      <div class="phead">
        ${modelIcon(r)}
        <div class="pname">
          <span class="ptitle">${escapeHtml(r.name || r.id)}</span>
          <span class="pid">${escapeHtml(r.id)}</span>
        </div>
      </div>
      <div class="pbars">${scoreBars(r)}</div>
      <div class="pfoot"><span class="poverall">${s.overall != null ? s.overall : "—"}<span class="psuffix">/100</span></span>${tileFoot(r)}</div>
      ${open ? `<div class="p-providers">${providerCards(r)}</div>` : ""}
    </article>`;
    }).join("") +
    "</div>";

  el.querySelectorAll(".ptile").forEach((tile) => {
    tile.addEventListener("click", () => {
      const id = tile.dataset.id;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      renderPodium();
    });
  });
}

/* ── chart — bar chart ranked by the active tab ───────────────────────── */

function renderChart() {
  const el = document.getElementById("chart");
  if (!el || !state.rows.length) return;
  const title = document.getElementById("chartTitle");
  const tab = state.tab;
  const N = state.topN;

  let rows, max, barW, barVal;
  if (tab === "ai") {
    title.textContent = `Intelligence Index — top ${N}`;
    setChartSource("chartSource", SOURCE_LINKS.aa);
    rows = state.rows.filter((r) => r.intel != null && passesIntel(r))
      .sort((a, b) => b.intel - a.intel).slice(0, N);
    max = 100;
    barW = (r) => (r.intel / max) * 100;
    barVal = (r) => `${fmtNum(r.intel)}<span class="hsub"> idx</span>`;
  } else if (tab === "arena") {
    title.textContent = `Arena rank — top ${N}`;
    setChartSource("chartSource", SOURCE_LINKS.lmarena);
    rows = state.rows.filter((r) => r.arena_rank != null && passesIntel(r))
      .sort((a, b) => a.arena_rank - b.arena_rank).slice(0, N);
    max = Math.max(...rows.map((r) => r.arena_rank), N);
    barW = (r) => (1 - (r.arena_rank - 1) / max) * 100;
    barVal = (r) => `#${r.arena_rank}`;
  } else if (tab === "price") {
    title.textContent = `Best value — Intel per $/1M — top ${N}`;
    setChartSource("chartSource", `${SOURCE_LINKS.openrouter} prices · ${SOURCE_LINKS.aa} intel`);
    rows = state.rows.filter((r) => r.intel != null && passesIntel(r))
      .sort((a, b) => valueOf(b) - valueOf(a)).slice(0, N);
    const maxV = Math.max(...rows.map(valueOf).filter(isFinite));
    max = maxV > 0 ? maxV : 1;
    barW = (r) => {
      const v = valueOf(r);
      if (!isFinite(v)) return 100; // free
      return (Math.log10(v) / Math.log10(max)) * 100;
    };
    barVal = (r) => `<span class="hval-free${valueOf(r) === Infinity ? " free" : ""}">${fmtValue(valueOf(r))}</span>`;
  } else {
    // overall: the blended 0–100 score
    title.textContent = `Overall score — top ${N}`;
    setChartSource("chartSource", `${SOURCE_LINKS.openrouter} prices · ${SOURCE_LINKS.aa} intel · ${SOURCE_LINKS.lmarena} arena`);
    rows = state.rows.filter((r) => passesIntel(r) && r._scores && r._scores.overall != null)
      .sort(podiumSort).slice(0, N);
    max = 100;
    barW = (r) => r._scores.overall;
    barVal = (r) => `${r._scores.overall}<span class="hsub">/100</span>`;
  }

  if (!rows.length) {
    el.innerHTML = '<p class="empty">No models match the filter.</p>';
    return;
  }

  el.innerHTML = '<div class="hbars">' + rows.map((r) => {
    const w = barW(r);
    return `<div class="hrow">
      <span class="hname" title="${escapeHtml(r.id)}">${escapeHtml(shortName(r))}</span>
      <span class="htrack"><i class="hfill" style="width:${Math.max(2, Math.min(100, w)).toFixed(1)}%"></i></span>
      <span class="hval">${barVal(r)}</span>
    </div>`;
  }).join("") + "</div>";
}

/* ── rows — the dense model table, ranked by the active tab ───────────── */

function cell(html, cls = "", label = "") {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (label) td.dataset.label = label;
  td.innerHTML = html;
  return td;
}

function headerCols() {
  if (state.tab === "ai") return [
    { key: "intel", label: "Intel" },
    { key: "coding", label: "Coding" },
    { key: "agentic", label: "Agentic" },
    { key: "arena", label: "Arena" },
    { key: "best", label: "Best $/1M" },
    { key: "providers", label: "Providers" },
  ];
  if (state.tab === "arena") return [
    { key: "arena", label: "Arena" },
    { key: "ai", label: "AI #" },
    { key: "best", label: "Best $/1M" },
    { key: "providers", label: "Providers" },
  ];
  if (state.tab === "price") return [
    { key: "best", label: "Best $/1M" },
    { key: "providers", label: "Providers" },
    { key: "ranks", label: "Ranks" },
  ];
  return [
    { key: "overall", label: "Overall" },
    { key: "value", label: "Value" },
    { key: "ai", label: "AI" },
    { key: "arena", label: "Arena" },
    { key: "best", label: "Best $/1M" },
    { key: "providers", label: "Providers" },
  ];
}

function renderHeader() {
  const thead = document.getElementById("thead");
  thead.innerHTML = "";
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.className = "col-rank";
  th.textContent = "#";
  tr.appendChild(th);
  for (const c of headerCols()) {
    const h = document.createElement("th");
    h.textContent = c.label;
    if (c.key === TABS[state.tab].metricKey) h.classList.add("sorted"); // frozen direction indicator
    tr.appendChild(h);
  }
  thead.appendChild(tr);
}

function rankCell(i) {
  const cls = i === 1 ? " r1" : i === 2 ? " r2" : i === 3 ? " r3" : "";
  return cell(`<span class="rank${cls}">${i}</span>`, "num col-rank", "Rank");
}

function scoreCell(v, cls) {
  const html = v == null ? '<span class="score none">—</span>' : `<span class="score ${cls}">${v}</span>`;
  return cell(html, "num", cls);
}

function modeCells(r) {
  const s = r._scores || {};
  if (state.tab === "ai") {
    return [
      cell(`<span class="score${r.intel == null ? " none" : ""}">${r.intel == null ? "—" : fmtNum(r.intel)}</span>`, "num", "Intel"),
      cell(`<span class="score sub${r.coding == null ? " none" : ""}">${r.coding == null ? "—" : fmtNum(r.coding)}</span>`, "num", "Coding"),
      cell(`<span class="score sub${r.agentic == null ? " none" : ""}">${r.agentic == null ? "—" : fmtNum(r.agentic)}</span>`, "num", "Agentic"),
      cell(r.arena_rank != null ? `<span class="arena-rank">#${r.arena_rank}</span>` : '<span class="none">—</span>', "num", "Arena"),
      bestCell(r),
      countCell(r),
    ];
  }
  if (state.tab === "arena") {
    return [
      arenaCell(r),
      cell(r._aiRank != null ? `<span class="score">#${r._aiRank}</span>` : '<span class="none">—</span>', "num", "AI #"),
      bestCell(r),
      countCell(r),
    ];
  }
  if (state.tab === "price") {
    return [bestCell(r), countCell(r), ranksCell(r)];
  }
  return [
    scoreCell(s.overall, "overall"),
    scoreCell(s.value, "value"),
    scoreCell(s.ai, "ai"),
    scoreCell(s.arena, "arena"),
    bestCell(r),
    countCell(r),
  ];
}

function bestCell(r) {
  const b = bestProvider(r);
  let bestHtml = '<span class="none">—</span>';
  if (b) {
    const [inP, outP] = provPrice(b);
    bestHtml = `<span class="best-price">${fmtMoney(inP)} / ${fmtMoney(outP)}</span><div class="best-line">via <em>${escapeHtml(b.provider)}</em></div>`;
  }
  if (r.default_provider) {
    bestHtml += `<div class="best-line def">default: <em class="def">${escapeHtml(r.default_provider)}</em></div>`;
  }
  return cell(bestHtml, "num", "Best $/1M");
}

function countCell(r) {
  const provCount = r.provider_count
    ? `<span class="count ${providerCountClass(r.provider_count)}">${r.provider_count}</span>`
    : '<span class="count">—</span>';
  return cell(provCount, "num", "Providers");
}

function arenaCell(r) {
  const rank = r.arena_rank;
  let sub = "";
  const cats = r.arena || {};
  const bestCat = Object.entries(cats)
    .filter(([k]) => k !== "overall")
    .sort((a, b) => a[1] - b[1])[0];
  if (bestCat) sub = `<div class="best-line">best cat: <em>${escapeHtml(bestCat[0])} #${bestCat[1]}</em></div>`;
  return cell(`<span class="arena-rank">#${rank}</span>${sub}`, "num", "Arena");
}

function ranksCell(r) {
  const parts = [];
  if (r.arena_rank != null) parts.push(`<span class="pbadge arena" title="LMArena rank">Arena #${r.arena_rank}</span>`);
  if (r._aiRank != null) parts.push(`<span class="pbadge ai" title="AI-test rank by Intelligence Index">AI #${r._aiRank}</span>`);
  return cell(parts.length ? parts.join(" ") : '<span class="none">—</span>', "num", "Ranks");
}

function providerCountClass(n) {
  if (n >= 10) return "many";
  if (n >= 3) return "mid";
  return "few";
}

function renderBody() {
  const q = state.search.trim().toLowerCase();
  const t = TABS[state.tab];
  let rows = state.rows.filter((r) => {
    if (q && !(r.name + " " + r.id + " " + (r.author || "")).toLowerCase().includes(q)) return false;
    return t.filter(r);
  }).sort(t.sort);

  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  const empty = document.getElementById("empty");
  empty.hidden = rows.length > 0;

  rows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.className = "main";
    tr.dataset.id = r.id;
    const expanded = state.expanded.has(r.id);
    if (expanded) tr.classList.add("expanded");
    const hasProviders = r.providers && r.providers.length;
    const free = r.providers.some((p) => p.is_free);

    const model = cell(
      `<div class="col-flex"><span class="micon-wrap">${modelIcon(r)}</span>`
      + `<span class="model-info">`
      + `<span class="model-line">${hasProviders ? '<span class="chevron">▶</span>' : ""}<span class="mname">${escapeHtml(r.name || r.id)}</span>${free ? '<span class="badge free">FREE</span>' : ""}</span>`
      + `<span class="mid">${escapeHtml(r.id)}</span>`
      + `</span></div>`,
      "col-model"
    );
    if (hasProviders) {
      tr.onclick = () => {
        if (state.expanded.has(r.id)) state.expanded.delete(r.id);
        else state.expanded.add(r.id);
        renderBody();
      };
    }

    const cells = [rankCell(idx + 1), model, ...modeCells(r)];
    tr.append(...cells);
    tbody.appendChild(tr);

    if (expanded && hasProviders) {
      const dtr = document.createElement("tr");
      dtr.className = "providers-row";
      const td = document.createElement("td");
      td.colSpan = 1 + 1 + headerCols().length;
      td.innerHTML = providerCards(r);
      dtr.appendChild(td);
      tbody.appendChild(dtr);
    }
  });
  updatePins();
}

/* ── pinned model row ────────────────────────────────────────────────── */

/* The table wrapper's overflow:auto makes position:sticky stick to it
   (which never scrolls) instead of the window, so the expanded model row
   is re-rendered as a fixed bar below the top bar while the user browses
   its provider list. Released when they scroll back to it or past the
   whole section. */
function updatePins() {
  const topbar = document.querySelector(".topbar");
  const pinTop = topbar ? topbar.getBoundingClientRect().height + 4 : 12;
  const table = document.querySelector("table");
  const bar = document.getElementById("pinbar");
  if (!table) {
    if (bar) bar.remove();
    return;
  }
  const tRect = table.getBoundingClientRect();

  // the first expanded row whose section straddles (or has crossed) the pin line
  let pinTarget = null;
  document.querySelectorAll("tr.main.expanded").forEach((row) => {
    if (pinTarget) return;
    const rowRect = row.getBoundingClientRect();
    const next = row.nextElementSibling; // the tr.providers-row with the cards
    const sectionBottom = next ? next.getBoundingClientRect().bottom : rowRect.bottom;
    if (rowRect.top < pinTop && sectionBottom > pinTop) pinTarget = row;
  });

  if (!pinTarget) {
    if (bar) bar.remove();
    return;
  }

  if (bar && bar.dataset.row === pinTarget.dataset.id) {
    // already pinned for this row — just keep its position fresh
    bar.style.left = tRect.left + "px";
    bar.style.width = tRect.width + "px";
    return;
  }
  if (bar) bar.remove();

  const cells = [...pinTarget.querySelectorAll("td")];
  const nb = document.createElement("div");
  nb.id = "pinbar";
  nb.className = "pinbar";
  nb.dataset.row = pinTarget.dataset.id;
  nb.style.top = pinTop + "px";
  nb.style.left = tRect.left + "px";
  nb.style.width = tRect.width + "px";

  if (window.innerWidth <= 720) {
    // compact: model identity + provider count
    const modelCell = cells[0].cloneNode(true);
    modelCell.style.flex = "1 1 auto";
    modelCell.style.maxWidth = "none";
    const countCell = cells[cells.length - 1].cloneNode(true);
    countCell.style.flex = "0 0 auto";
    nb.append(modelCell, countCell);
  } else {
    // clone each cell so the bar matches the table's column widths
    const widths = cells.map((td) => td.offsetWidth);
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    cells.forEach((td, i) => {
      const c = td.cloneNode(true);
      c.style.flex = `0 0 ${(widths[i] / total) * 100}%`;
      nb.appendChild(c);
    });
  }
  // the bar is the row — clicking it collapses the model again
  nb.title = "Click to collapse";
  nb.addEventListener("click", () => {
    state.expanded.delete(nb.dataset.row);
    renderBody();
    const tr = document.querySelector(`tr.main[data-id="${CSS.escape(nb.dataset.row)}"]`);
    if (tr) tr.scrollIntoView({ block: "center" });
  });
  document.body.appendChild(nb);
}

/* ── provider expansion (cards with reliability) ──────────────────────── */

function providerCards(r) {
  const provs = [...r.providers].sort((a, b) => providerCost(a) - providerCost(b));
  const cards = provs.map((p) => {
    const [inP, outP] = provPrice(p);
    const cost = providerCost(p);
    const isBest = cost === bestCost(r);
    const isDefault = !!p.is_default;
    const eff = p.eff_in != null;
    const priceTag = eff ? '<span class="tag market">market</span>' : '<span class="tag base">base</span>';

    const baseBlend = p.in != null && p.out != null ? (IO_RATIO * p.in + p.out) / (IO_RATIO + 1) : null;
    const disc = eff && baseBlend && baseBlend > 0 ? Math.round((1 - cost / baseBlend) * 100) : null;

    const up1d = p.uptime_1d;
    const up30 = p.uptime_30m;
    const meter = (v) => (v != null ? Math.max(2, Math.min(100, v)).toFixed(1) : 0);
    const pct = (v) => (v != null ? `${v.toFixed(1)}%` : '<span class="none">—</span>');

    const meta = [];
    if (eff) meta.push(`<b>${fmtPct(p.cache_hit_rate)}</b> cache`);
    if (p.quantization) meta.push(`<b>${escapeHtml(p.quantization)}</b>`);

    const cls = `pcard${isBest ? " best" : ""}${isDefault ? " default" : ""}`;

    return `<div class="${cls}">
      <div class="pcard-top">
        ${providerIcon(p)}
        <span class="pname" title="${escapeHtml(p.provider)}">${escapeHtml(p.provider)}</span>
        ${isDefault ? '<span class="tag default">default</span>' : ""}
        ${isBest ? '<span class="tag cheapest">cheapest</span>' : ""}
        ${priceTag}
      </div>
      <div class="pprice">
        <span class="big">${fmtMoney(inP)}</span><span class="slash">/</span><span class="big">${fmtMoney(outP)}</span>
        ${disc != null && disc > 0 ? `<span class="disc">−${disc}% vs list</span>` : ""}
      </div>
      <div class="prel">
        <span class="prel-label" title="OpenRouter-reported endpoint availability, last 24h — availability only, not output quality.">uptime 24h</span>
        <span class="meter"><i style="width:${meter(up1d)}%"></i></span>
        <span class="prel-val">${pct(up1d)}</span>
      </div>
      <div class="prel uptime">
        <span class="prel-label" title="OpenRouter-reported endpoint availability, last 30 minutes.">uptime 30m</span>
        <span class="meter"><i style="width:${meter(up30)}%"></i></span>
        <span class="prel-val">${pct(up30)}</span>
      </div>
      ${meta.length ? `<div class="pmeta">${meta.join(" · ")}</div>` : ""}
    </div>`;
  }).join("");

  return `
    <div class="providers">
      <div class="providers-title"><b>${r.provider_count}</b> provider${r.provider_count === 1 ? "" : "s"} · cheapest first · <em>uptime = OpenRouter-reported availability, not quality</em></div>
      <div class="providers-grid">${cards}</div>
    </div>`;
}

/* ── init ─────────────────────────────────────────────────────────────── */

function render() {
  renderPodium();
  renderChart();
  renderHeader();
  renderBody();
}

async function init() {
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    state.search = search.value;
    renderBody();
  });

  const tabs = document.getElementById("chartTabs");
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".mode-btn");
    if (!btn) return;
    state.tab = btn.dataset.tab;
    state.expanded.clear();
    tabs.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });

  const minIntel = document.getElementById("minIntel");
  if (minIntel) {
    const val = document.getElementById("minIntelVal");
    minIntel.addEventListener("input", () => {
      state.minIntel = +minIntel.value;
      if (val) val.textContent = state.minIntel;
      render();
    });
  }
  const topN = document.getElementById("topN");
  if (topN) {
    const val = document.getElementById("topNVal");
    topN.addEventListener("input", () => {
      state.topN = +topN.value;
      if (val) val.textContent = state.topN;
      renderChart();
    });
  }

  // capture-phase scroll catches window scroll + the table wrapper's own
  // horizontal scroll; resize keeps the pinned bar's width honest
  document.addEventListener("scroll", updatePins, { capture: true, passive: true });
  window.addEventListener("resize", updatePins);

  try {
    const resp = await fetch("data/models.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.rows = data.models;
    computeScores();
    renderStats(data.meta || {});
    render();
  } catch (err) {
    const cs = document.getElementById("chartStats");
    if (cs) cs.textContent = "Could not load data/models.json — run scripts/fetch_data.py first";
    console.error(err);
  }
}

init();
