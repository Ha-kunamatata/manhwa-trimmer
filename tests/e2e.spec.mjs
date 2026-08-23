import { test, expect } from "@playwright/test";
import { makePng } from "./fixtures.mjs";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fixtures are written per worker.
 *
 * This file is evaluated once in every Playwright worker, so a shared path means
 * eight processes writing the same PNGs while the browser is reading them. That
 * hands the decoder a half-written file, which surfaces as a page that will not
 * render — a fixture bug wearing an application bug's clothes.
 */
const WORKER = process.env.TEST_PARALLEL_INDEX ?? "0";
const FIXTURES = join(tmpdir(), "manhwa-trimmer-tests", "w" + WORKER);

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
  mkdirSync(FIXTURES, { recursive: true });
  const file = join(FIXTURES, "strip.png");
  writeFileSync(file, png);
  return { file, pages: PAGES };
}

/** A small library on disk: two series, two chapters each, three pages a chapter. */
function buildLibraryTree() {
  const root = join(FIXTURES, "library");
  const plan = { 원피스: ["001화", "002화"], 나루토: ["001화"] };
  for (const [series, chapters] of Object.entries(plan)) {
    for (const ch of chapters) {
      const dir = join(root, series, ch);
      mkdirSync(dir, { recursive: true });
      for (let p = 1; p <= 3; p++) {
        // portrait pages, each a different shade so a turn is visible
        const png = makePng(300, 420, ({ rect }) => rect(0, 0, 300, 420, [60 + p * 40, 90, 120]));
        writeFileSync(join(dir, `p${String(p).padStart(2, "0")}.png`), png);
      }
    }
  }
  return { root, series: 2, chapters: 2, pages: 3 };
}

const strip = buildStrip();
const lib = buildLibraryTree();

async function load(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html#/edit");
  await page.setInputFiles("#fileInput", strip.file);
  await page.waitForSelector("#results:not([hidden])", { timeout: 30_000 });
  await page.waitForTimeout(500);
  return errors;
}

/** A wide window opens on a spread; pin it to one leaf so page counts are exact. */
async function forceSingle(page) {
  if ((await page.textContent("#rSpread")).trim() === "두 쪽") await page.click("#rSpread");
  await expect(page.locator("#rSpread")).toHaveText("한 쪽");
}

async function loadLibrary(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // the reader reports a failed step to the console rather than throwing, so a
  // silent decode failure would otherwise look like the reader merely stalling
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/index.html#/library");
  await page.setInputFiles("#folderInput", lib.root);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
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

test("saving works on the hosted page, with no Claude host present", async ({ page }) => {
  // nothing defines window.claude here — this is the plain deployed PWA, which
  // is where the export half is actually used
  await load(page);
  const started = page.waitForEvent("download", { timeout: 60_000 });
  await page.click("#downloadPdfBtn");
  expect((await started).suggestedFilename()).toMatch(/\.pdf$/);
});

test("no horizontal overflow at any width", async ({ page }) => {
  await load(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});

test("the home screen routes to both halves and back", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("#homeView")).toBeVisible();
  await expect(page.locator("#editView")).toBeHidden();

  await page.click("#goLibrary");
  await expect(page.locator("#libView")).toBeVisible();
  expect(page.url()).toContain("#/library");

  await page.click("#backHome");
  await expect(page.locator("#homeView")).toBeVisible();

  await page.click("#goEdit");
  await expect(page.locator("#editView")).toBeVisible();
  await expect(page.locator("#dropzone")).toBeVisible();
});

test("a folder becomes series and chapters", async ({ page }) => {
  const errors = await loadLibrary(page);
  await expect(page.locator("#seriesGrid .series-card")).toHaveCount(lib.series);
  // natural order, not string order
  await expect(page.locator(".series-card .series-name").first()).toHaveText("나루토");

  await page.locator(".series-card", { hasText: "원피스" }).click();
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(lib.chapters);
  await expect(page.locator(".chapter-row .ch-name").first()).toHaveText("001화");
  expect(errors).toEqual([]);
});

test("reading a chapter runs on into the next one", async ({ page }) => {
  const errors = await loadLibrary(page);
  await page.locator(".series-card", { hasText: "원피스" }).click();
  await page.locator(".chapter-row").first().click();

  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#rSub")).toHaveText("001화");
  await forceSingle(page);
  await expect(page.locator("#rCount")).toContainText(`/ ${lib.pages}`);

  // step off the end of chapter one and land at the start of chapter two
  for (let i = 0; i < lib.pages; i++) await page.click("#rZoneL");
  await expect(page.locator("#rSub")).toHaveText("002화");
  await expect(page.locator("#rCount")).toContainText(`1 / ${lib.pages}`);

  await page.keyboard.press("Escape");
  await expect(page.locator("#reader")).toBeHidden();

  // the library remembers where reading stopped: the chapter is marked here,
  // and the series carries a 이어보기 badge one level up
  await expect(page.locator(".chapter-row.reading .ch-name")).toHaveText("002화");
  await page.click(".crumb-back");
  await expect(page.locator(".series-card", { hasText: "원피스" })).toContainText("이어보기");
  expect(errors).toEqual([]);
});

test("the single-file artifact build runs", async ({ page }) => {
  test.skip(!existsSync("dist/artifact.html"), "run npm run build first");
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/dist/artifact.html");
  await expect(page.locator("#homeView")).toBeVisible();
  await page.click("#goLibrary");
  await expect(page.locator("#libView")).toBeVisible();
  // nothing in an artifact can reach GitHub, so that door is not shown
  await expect(page.locator("#ghToggle")).toBeHidden();
  await expect(page.locator("#pickFolderBtn")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the page turn leaves the right page on screen", async ({ page }) => {
  await loadLibrary(page);
  await page.locator(".series-card", { hasText: "나루토" }).click();
  await page.locator(".chapter-row").first().click();
  await forceSingle(page);
  await expect(page.locator("#rCount")).toHaveText(`1 / ${lib.pages}`);

  await page.click("#rZoneL");
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);
  // the turning sheet must be gone once it has landed
  await expect(page.locator("#rFlip")).toBeHidden();
  await expect(page.locator("#rCanvas")).toBeVisible();
});
