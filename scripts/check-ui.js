/* Render every UI state with system Chrome, screenshot it, and report text
   clipping / overflow so cut text can be found without eyeballing pixels. */
"use strict";

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.UI_BASE || "http://localhost:8765/";
const OUT = path.join(__dirname, "..", "screenshots");

async function detectOverflow(page) {
  return page.evaluate(() => {
    const issues = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 2) {
      issues.push({
        type: "page-overflow",
        el: "html",
        text: `page scrollWidth ${root.scrollWidth} > viewport ${root.clientWidth}`,
      });
    }
    const els = document.querySelectorAll("body *");
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (el.clientWidth <= 0 || el.clientHeight <= 0) continue;
      if (cs.whiteSpace === "nowrap" && cs.overflow === "visible") {
        if (el.scrollWidth > el.clientWidth + 2) {
          const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
          const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : el.tagName;
          issues.push({
            type: "text-clip",
            el: `${el.tagName}.${cls || "?"}`,
            text: txt,
            w: `${el.scrollWidth}>${el.clientWidth}`,
          });
        }
      }
    }
    return issues;
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  const snap = async (name) => {
    await page.screenshot({ path: path.join(OUT, name) });
    const issues = await detectOverflow(page);
    issues.forEach((i) => results.push({ state: name, ...i }));
    console.log(`shot ${name} — ${issues.length} overflow issue(s)`);
  };

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".ptile");
  await snap("1-default.png"); // podium + chart + rows

  // expand a podium tile → providers
  await page.click(".ptile");
  await page.waitForSelector(".ptile .p-providers");
  await snap("2-podium-expanded.png");
  await page.click(".ptile.open"); // collapse
  await page.waitForTimeout(150);

  // expand a table row → providers
  await page.click("#tbody tr.main");
  await page.waitForSelector(".providers-row .providers");
  await snap("3-row-expanded.png");
  await page.click("#tbody tr.main.expanded"); // collapse
  await page.waitForTimeout(150);

  await page.fill("#search", "claude");
  await page.waitForTimeout(350);
  await snap("4-search.png");
  await page.fill("#search", "");
  await page.waitForTimeout(200);

  // tab toggles re-rank the chart + rows
  for (const tab of ["ai", "arena", "price"]) {
    await page.click(`#chartTabs .mode-btn[data-tab="${tab}"]`);
    await page.waitForTimeout(300);
    await snap(`5-${tab}.png`);
    await page.click("#tbody tr.main");
    await page.waitForSelector(".providers-row .providers");
    await page.waitForTimeout(250);
    await snap(`6-${tab}-expanded.png`);
    await page.click("#tbody tr.main.expanded");
    await page.waitForTimeout(150);
  }
  await page.click('#chartTabs .mode-btn[data-tab="overall"]');
  await page.waitForTimeout(250);
  await snap("7-overall.png");

  // min-intel filter still applies
  await page.evaluate(() => {
    const s = document.getElementById("minIntel");
    s.value = "0";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await snap("8-minintel-0.png");
  await page.evaluate(() => {
    const s = document.getElementById("minIntel");
    s.value = "50";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(250);

  // narrow desktop — where clipping shows up most
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(250);
  await snap("9-narrow.png");
  await page.click(".ptile");
  await page.waitForSelector(".ptile .p-providers");
  await page.waitForTimeout(250);
  await snap("10-narrow-podium-expanded.png");
  await page.click(".ptile.open"); // collapse before resizing
  await page.waitForTimeout(150);

  // mobile — podium stacks, rows become cards
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await snap("11-mobile.png");
  await page.click("#tbody tr.main");
  await page.waitForSelector(".providers-row .providers");
  await page.waitForTimeout(250);
  await snap("12-mobile-expanded.png");

  await browser.close();

  const byType = {};
  for (const r of results) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log("\n=== OVERFLOW SUMMARY ===");
  console.log(JSON.stringify(byType, null, 2));

  const seen = new Set();
  let shown = 0;
  for (const r of results) {
    const key = `${r.state}|${r.el}|${r.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shown++;
    if (shown > 40) break;
    console.log(`[${r.state}] ${r.type} ${r.el}: "${r.text}" (${r.w})`);
  }
  console.log(`\nscreenshots → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
