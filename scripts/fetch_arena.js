#!/usr/bin/env node
/* Scrape the LMArena (arena.ai) text leaderboard and cache it to
   data/arena_raw.json. The table is client-rendered behind a Cloudflare
   challenge, so we drive a real browser (system Chrome via playwright-core,
   which is already a dev dependency) and read the rendered DOM.

   Output: data/arena_raw.json
   [
     { "arena_id": "claude-fable-5", "overall": 1, "expert": 1, "hard": 2,
       "coding": 1, "math": 2, "creative": 1, "instruction": 2, "longer": 2,
       "url": "https://arena.ai/models/claude-fable-5" },
     ...
   ]

   Usage:  node scripts/fetch_arena.js
   Env:    ARENA_URL (default https://lmarena.ai/leaderboard)
           CHROME (path to chrome; defaults to Playwright's bundled chromium,
                   falling back to the system Chrome install on Windows)
   */
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

/* Browser resolution order: explicit CHROME env → playwright-core's own
   executablePath (version-matched to the installed package; this is what CI
   installs via `npx playwright install chromium`) → scan the standard
   ms-playwright caches → system Chrome (Windows only). */
function findPlaywrightChrome() {
  // 1) playwright-core computes the exact path for its own version.
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  // 2) scan the usual ms-playwright cache locations on any OS.
  const roots = [];
  if (process.env.HOME) roots.push(path.join(process.env.HOME, ".cache", "ms-playwright"));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "ms-playwright"));
  if (process.env.USERPROFILE) roots.push(path.join(process.env.USERPROFILE, ".cache", "ms-playwright"));
  const layouts = ["chrome-linux/chrome", "chrome-win64/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"];
  for (const cache of roots) {
    try {
      if (!fs.existsSync(cache)) continue;
      for (const dir of fs.readdirSync(cache).sort().reverse()) {
        for (const rel of layouts) {
          const bin = path.join(cache, dir, ...rel.split("/"));
          if (fs.existsSync(bin)) return bin;
        }
      }
    } catch { /* fall through */ }
  }
  return null;
}

const found = process.env.CHROME || findPlaywrightChrome();
let CHROME;
if (found) {
  CHROME = found;
} else if (process.platform === "win32") {
  CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
} else {
  console.error("[arena] no chromium found — install it with: npx playwright install chromium");
  process.exit(1);
}
const URL = process.env.ARENA_URL || "https://lmarena.ai/leaderboard";
const OUT = path.join(__dirname, "..", "data", "arena_raw.json");

const CATS = ["overall", "expert", "hard", "coding", "math", "creative", "instruction", "longer"];

async function main() {
  console.log(`[arena] launching ${CHROME} ...`);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  console.log(`[arena] loading ${URL} ...`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // the table is client-rendered; wait for rows to appear
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  await page.waitForTimeout(4000);

  const rows = await page.evaluate((cats) => {
    const trs = [...document.querySelectorAll("table tbody tr")];
    return trs.map((tr) => {
      const id = tr.querySelector("[title]")?.getAttribute("title") || "";
      const tds = [...tr.querySelectorAll("td")];
      const vals = tds.slice(1, 1 + cats.length).map((td) => {
        const n = parseInt(td.innerText.trim());
        return Number.isFinite(n) ? n : null;
      });
      const obj = { arena_id: id.trim() };
      cats.forEach((c, i) => (obj[c] = vals[i]));
      return obj;
    });
  }, CATS);

  const clean = rows.filter((r) => r.arena_id);
  console.log(`[arena] scraped ${clean.length} models`);
  fs.writeFileSync(OUT, JSON.stringify(clean, null, 1));
  console.log(`[arena] wrote ${OUT}`);
  await browser.close();
}

main().catch((err) => {
  console.error("[arena] failed:", err.message);
  process.exit(1);
});
