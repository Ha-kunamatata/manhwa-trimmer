import { test, expect } from "@playwright/test";
import { makePng } from "./fixtures.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A capture that looks like the real thing: colour ad banners, side margins,
 *  a grayscale comic column of 9 pages with panels and margins between them. */
function buildStrip() {
  const W = 900, COL_L = 160, COL_R = 740;
  const TOP = 220, PAGES = 9, PAGE_H = 820, GUT = 30, BOT = 180;
  const H = TOP + PAGES * PAGE_H + (PAGES - 1) * GUT + BOT;
  const png = makePng(W, H, ({ rect }) => {
    rect(0, 0, W, 24, [30, 30, 34]);                       // site header
    for (let i = 0; i < 6; i++)                            // colour ad banner
      rect((i * W) / 6, 34, ((i + 1) * W) / 6, TOP - 24, [200 + i * 8, 60 + i * 20, 90 + i * 25]);
    let y = TOP;
    for (let p = 0; p < PAGES; p++) {
      const panelH = Math.floor(PAGE_H / 4);
      for (let k = 0; k < 4; k++) {
        const a = y + k * panelH + 6, b = y + (k + 1) * panelH - 2;
        rect(COL_L + 6, a, COL_R - 6, b, [40 + ((p * 17 + k * 29) % 150)] * 1 ? [40 + ((p * 17 + k * 29) % 150), 40 + ((p * 17 + k * 29) % 150), 40 + ((p * 17 + k * 29) % 150)] : [90, 90, 90]);
      }
      y += PAGE_H + GUT;
    }
    for (let i = 0; i < 6; i++)                            // bottom banner
      rect((i * W) / 6, H - BOT + 20, ((i + 1) * W) / 6, H - 30, [190 + i * 9, 70 + i * 18, 120 + i * 20]);
    rect(0, H - 26, W, H, [30, 30, 34]);                   // footer
  });
  const dir = join(tmpdir(), "manhwa-trimmer-tests");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "strip.png");
  writeFileSync(file, png);
  return { file, pages: PAGES };
}

const strip = buildStrip();

async function load(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html");
  await page.setInputFiles("#fileInput", strip.file);
  await page.waitForSelector("#results:not([hidden])", { timeout: 30_000 });
  await page.waitForTimeout(500);
  return errors;
}

test("splits the strip into the right number of pages", async ({ page }) => {
  const errors = await load(page);
  await expect(page.locator("#pageGrid .page-card")).toHaveCount(strip.pages);
  await expect(page.locator("#ratioHint")).toContainText("한 페이지 배치");
  expect(errors).toEqual([]);
});

test("crops the site chrome away", async ({ page }) => {
  await load(page);
  const crop = await page.evaluate(() => ({
    left: +document.querySelector("#cropLeft").value,
    right: +document.querySelector("#cropRight").value,
    top: +document.querySelector("#cropTop").value
  }));
  expect(crop.left).toBeGreaterThan(100);   // the blank side margin
  expect(crop.right).toBeGreaterThan(100);
  expect(crop.top).toBeGreaterThan(150);    // header + ad banner
});

test("reader opens, turns pages and closes", async ({ page }) => {
  await load(page);
  await page.click("#readBtn");
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#rCount")).toContainText(`/ ${strip.pages}`);

  const first = await page.textContent("#rCount");
  await page.click("#rZoneL");                        // right-to-left: left advances
  await expect(page.locator("#rCount")).not.toHaveText(first);
  await page.click("#rZoneR");
  await expect(page.locator("#rCount")).toHaveText(first);

  await page.keyboard.press("End");
  await expect(page.locator("#rCount")).toContainText(`${strip.pages} / ${strip.pages}`);
  await page.keyboard.press("Escape");
  await expect(page.locator("#reader")).toBeHidden();
});

test("two-page spread pairs the leaves", async ({ page }) => {
  await load(page);
  await page.click("#readBtn");
  const mode = await page.textContent("#rSpread");
  if (mode.trim() === "한 쪽") await page.click("#rSpread");
  await expect(page.locator("#rSpread")).toHaveText("두 쪽");
  await expect(page.locator("#rCover")).toBeVisible();

  await expect(page.locator("#rCount")).toContainText("1 /");   // cover stands alone
  // compare shape, not pixel width: on a narrow screen both fit to the same
  // width, but a pair is about twice as wide relative to its height
  const aspect = () => page.evaluate(() => {
    const c = document.querySelector("#rCanvas");
    return c.width / c.height;
  });
  const single = await aspect();
  await page.click("#rZoneL");
  await expect(page.locator("#rCount")).toContainText("–");     // now a pair
  const pair = await aspect();
  expect(pair).toBeGreaterThan(single * 1.7);
});

test("exports a PDF with one page per comic page", async ({ page }) => {
  await load(page);
  const info = await page.evaluate(async () => {
    let captured = null;
    window.claude = { use: async (n) => (n === "downloads"
      ? { save: async (r) => { captured = r; return { status: "saved" }; } } : null) };
    document.querySelector("#downloadPdfBtn").click();
    for (let i = 0; i < 300 && !captured; i++) await new Promise((r) => setTimeout(r, 100));
    if (!captured) return null;
    const text = new TextDecoder("latin1").decode(captured.data);
    return { name: captured.filename, header: text.slice(0, 8),
             pages: (text.match(/\/Type \/Page[^s]/g) || []).length };
  });
  expect(info).not.toBeNull();
  expect(info.name).toMatch(/\.pdf$/);
  expect(info.header).toBe("%PDF-1.4");
  expect(info.pages).toBe(strip.pages);
});

test("no horizontal overflow at any width", async ({ page }) => {
  await load(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});
