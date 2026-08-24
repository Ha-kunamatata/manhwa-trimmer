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

/**
 * A folder of comics that have NOT been cut yet: one long capture per chapter,
 * site chrome and all — which is what comes off a screen recording session, and
 * what the viewer has to slice on its own.
 */
function buildUncutTree() {
  const root = join(FIXTURES, "uncut");
  const PAGES = 5, PAGE_H = 700, GUT = 40, TOP = 150, BOT = 120;
  const W = 700, COL_L = 90, COL_R = 610;
  const H = TOP + PAGES * PAGE_H + (PAGES - 1) * GUT + BOT;
  for (const ch of ["001화", "002화"]) {
    mkdirSync(join(root, "슬램덩크"), { recursive: true });
    writeFileSync(join(root, "슬램덩크", ch + ".png"), makePng(W, H, ({ rect }) => {
      rect(0, 0, W, 30, [28, 28, 32]);                          // site header
      for (let i = 0; i < 5; i++)                               // colour ad banner
        rect(i * W / 5, 40, (i + 1) * W / 5, TOP - 20, [210, 70 + i * 22, 100]);
      let y = TOP;
      for (let p = 0; p < PAGES; p++) {
        const panelH = Math.floor(PAGE_H / 4);
        for (let k = 0; k < 4; k++) {
          const v = 45 + ((p * 23 + k * 31) % 140);
          rect(COL_L + 6, y + k * panelH + 6, COL_R - 6, y + (k + 1) * panelH - 2, [v, v, v]);
        }
        y += PAGE_H + GUT;
      }
      rect(0, H - 26, W, H, [28, 28, 32]);                      // footer
    }));
  }
  return { root, chapters: 2, pages: PAGES };
}

/**
 * A chapter that opens on a full-colour cover, under a colour ad banner.
 *
 * This is the shape that used to lose its cover: the chrome detector trimmed
 * down to the last coloured row, and a cover is coloured all the way down.
 */
function buildColourCover() {
  const W = 800, COL_L = 110, COL_R = 690;
  const TOP = 200, PAGES = 6, PAGE_H = 760, GUT = 34, BOT = 150;
  const H = TOP + PAGES * PAGE_H + (PAGES - 1) * GUT + BOT;
  const png = makePng(W, H, ({ rect }) => {
    rect(0, 0, W, 26, [26, 26, 30]);                        // site header
    for (let i = 0; i < 6; i++)                             // colour ad banner
      rect(i * W / 6, 36, (i + 1) * W / 6, TOP - 30, [205 + i * 6, 65 + i * 21, 95 + i * 24]);
    let y = TOP;
    for (let p = 0; p < PAGES; p++) {
      if (p === 0) {
        // the cover: saturated over its whole height, like real cover art
        rect(COL_L + 4, y + 4, COL_R - 4, y + PAGE_H - 6, [198, 74, 96]);
        rect(COL_L + 60, y + 120, COL_R - 60, y + 430, [64, 128, 196]);
        rect(COL_L + 40, y + 470, COL_R - 40, y + PAGE_H - 70, [232, 176, 62]);
      } else {
        const panelH = Math.floor(PAGE_H / 4);
        for (let k = 0; k < 4; k++) {
          const v = 44 + ((p * 19 + k * 27) % 150);
          rect(COL_L + 6, y + k * panelH + 6, COL_R - 6, y + (k + 1) * panelH - 2, [v, v, v]);
        }
      }
      y += PAGE_H + GUT;
    }
    rect(0, H - 24, W, H, [26, 26, 30]);                    // footer
  });
  mkdirSync(FIXTURES, { recursive: true });
  const file = join(FIXTURES, "cover.png");
  writeFileSync(file, png);
  return { file, pages: PAGES, top: TOP };
}

const strip = buildStrip();
const cover = buildColourCover();
const lib = buildLibraryTree();
const uncut = buildUncutTree();

async function load(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html#/edit");
  await page.setInputFiles("#fileInput", strip.file);
  await page.waitForSelector("#results:not([hidden])", { timeout: 30_000 });
  await page.waitForTimeout(500);
  return errors;
}

/**
 * Tap one edge of the page to turn it.
 *
 * The reader has no hit-area elements any more — a tap, a drag-turn and a pinch
 * all come off the same pointer stream on the stage — so tests aim at a point
 * the way a reader's thumb does.
 */
async function tapEdge(page, side) {
  const box = await page.locator("#rStage").boundingBox();
  const x = side === "left" ? box.x + box.width * 0.12 : box.x + box.width * 0.88;
  await page.mouse.click(x, box.y + box.height / 2);
}
const turnOn = (page) => tapEdge(page, "left");    // right-to-left: left advances
const turnBack = (page) => tapEdge(page, "right");

/** The view controls live behind the settings button now. */
async function openSettings(page) {
  if (await page.locator("#rSettingsPanel").isHidden()) await page.click("#rSettings");
  await expect(page.locator("#rSettingsPanel")).toBeVisible();
}

/** A wide window opens on a spread; pin it to one leaf so page counts are exact. */
async function forceSingle(page) {
  await openSettings(page);
  if ((await page.textContent("#rSpread")).trim() === "두 쪽") await page.click("#rSpread");
  await expect(page.locator("#rSpread")).toHaveText("한 쪽");
  await page.keyboard.press("Escape");
  await expect(page.locator("#rSettingsPanel")).toBeHidden();
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

test("a colour cover is not mistaken for an advert", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html#/edit");
  await page.setInputFiles("#fileInput", cover.file);
  await page.waitForSelector("#results:not([hidden])", { timeout: 30_000 });

  // the banner goes, the cover stays, and the cover counts as a page
  const top = await page.evaluate(() => +document.querySelector("#cropTop").value);
  expect(top).toBeGreaterThan(120);            // the banner was trimmed
  expect(top).toBeLessThanOrEqual(cover.top + 40);  // but the cover was not
  await expect(page.locator("#pageGrid .page-card")).toHaveCount(cover.pages);
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
  await turnOn(page);
  await expect(page.locator("#rCount")).not.toHaveText(first);
  await turnBack(page);
  await expect(page.locator("#rCount")).toHaveText(first);

  await page.keyboard.press("End");
  await expect(page.locator("#rCount")).toContainText(`${strip.pages} / ${strip.pages}`);
  await page.keyboard.press("Escape");
  await expect(page.locator("#reader")).toBeHidden();
});

test("two-page spread pairs the leaves", async ({ page }) => {
  await load(page);
  await page.click("#readBtn");
  await openSettings(page);
  if ((await page.textContent("#rSpread")).trim() === "한 쪽") await page.click("#rSpread");
  await expect(page.locator("#rSpread")).toHaveText("두 쪽");
  await expect(page.locator("#rCover")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator("#rCount")).toContainText("1 /");   // cover stands alone
  // compare shape, not pixel width: on a narrow screen both fit to the same
  // width, but a pair is about twice as wide relative to its height
  const aspect = () => page.evaluate(() => {
    const c = document.querySelector("#rCanvas");
    return c.width / c.height;
  });
  const single = await aspect();
  await turnOn(page);
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

test("the app opens on the viewer, with the editor a button away", async ({ page }) => {
  await page.goto("/index.html");
  // reading is the front door: no landing screen to step through
  await expect(page.locator("#libView")).toBeVisible();
  await expect(page.locator("#editView")).toBeHidden();
  await expect(page.locator("#pickFolderBtn")).toBeVisible();
  await expect(page.locator("#goEdit")).toBeVisible();
  await expect(page.locator("#backHome")).toBeHidden();

  await page.click("#goEdit");
  await expect(page.locator("#editView")).toBeVisible();
  await expect(page.locator("#dropzone")).toBeVisible();
  expect(page.url()).toContain("#/edit");
  await expect(page.locator("#goEdit")).toBeHidden();

  await page.click("#backHome");
  await expect(page.locator("#libView")).toBeVisible();
  await expect(page.locator("#editView")).toBeHidden();
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
  for (let i = 0; i < lib.pages; i++) await turnOn(page);
  await expect(page.locator("#rSub")).toHaveText("002화");
  await expect(page.locator("#rCount")).toContainText(`1 / ${lib.pages}`);

  await page.keyboard.press("Escape");
  await expect(page.locator("#reader")).toBeHidden();

  // the library remembers where reading stopped: the chapter is marked here,
  // and the series carries its progress one level up
  await expect(page.locator(".chapter-row.reading .ch-name")).toHaveText("002화");
  await page.click(".crumb-back");
  await expect(page.locator(".series-card", { hasText: "원피스" })).toContainText("읽음");
  expect(errors).toEqual([]);
});

test("an uncut capture is sliced into pages by the viewer", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/index.html#/library");
  await page.setInputFiles("#folderInput", uncut.root);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });

  // one capture per chapter, so each file is its own chapter
  await page.locator(".series-card", { hasText: "슬램덩크" }).click();
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(uncut.chapters);
  await expect(page.locator(".chapter-row .ch-name").first()).toHaveText("001화");

  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible({ timeout: 30_000 });
  await forceSingle(page);
  // the capture held five pages; the viewer found them without being told
  await expect(page.locator("#rCount")).toHaveText(`1 / ${uncut.pages}`, { timeout: 30_000 });

  // and the site chrome is gone: a sliced page is about a page's shape, not a
  // strip's, which is the whole point of running the trimmer's judgement here
  const shape = await page.evaluate(() => {
    const c = document.querySelector("#rCanvas");
    return c.height / c.width;
  });
  expect(shape).toBeGreaterThan(1.0);
  expect(shape).toBeLessThan(2.0);

  await turnOn(page);
  await expect(page.locator("#rCount")).toHaveText(`2 / ${uncut.pages}`);
  expect(errors).toEqual([]);
});

test("the single-file artifact build runs", async ({ page }) => {
  test.skip(!existsSync("dist/artifact.html"), "run npm run build first");
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/dist/artifact.html");
  await expect(page.locator("#libView")).toBeVisible();
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

  await turnOn(page);
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);
  // the turning sheet must be gone once it has landed
  await expect(page.locator("#rFlip")).toBeHidden();
  await expect(page.locator("#rCanvas")).toBeVisible();
});

// ---------- the reader's own features ----------

/** Open a chapter of the plain page library, pinned to one leaf. */
async function openChapter(page) {
  const errors = await loadLibrary(page);
  await page.locator(".series-card", { hasText: "원피스" }).click();
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await forceSingle(page);
  return errors;
}

test("a page can be pinned, found in the list and jumped back to", async ({ page }) => {
  const errors = await openChapter(page);
  await turnOn(page);
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);

  await page.click("#rPin");
  await expect(page.locator("#rPin")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#rPinCount")).toHaveText("1");

  // leave the page, then come back to it through the list
  await turnOn(page);
  await expect(page.locator("#rCount")).toHaveText(`3 / ${lib.pages}`);
  await page.click("#rPinList");
  await expect(page.locator("#rPinPanel")).toBeVisible();
  await page.locator("#rPinList2 .pin-row .where").first().click();
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);
  await expect(page.locator("#rPin")).toHaveAttribute("aria-pressed", "true");

  // and it comes off again
  await page.click("#rPin");
  await expect(page.locator("#rPinCount")).toHaveText("0");
  expect(errors).toEqual([]);
});

test("pins survive closing the reader", async ({ page }) => {
  await openChapter(page);
  await page.click("#rPin");
  await expect(page.locator("#rPinCount")).toHaveText("1");
  await page.keyboard.press("Escape");
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#rPinCount")).toHaveText("1");
});

test("the page list jumps straight to a page", async ({ page }) => {
  const errors = await openChapter(page);
  await page.click("#rThumbBtn");
  await expect(page.locator("#rThumbs")).toBeVisible();
  await expect(page.locator("#rThumbGrid .thumb")).toHaveCount(lib.pages);
  await page.locator("#rThumbGrid .thumb").nth(2).click();
  await expect(page.locator("#rThumbs")).toBeHidden();
  await expect(page.locator("#rCount")).toHaveText(`3 / ${lib.pages}`);
  expect(errors).toEqual([]);
});

test("the slider moves through the chapter", async ({ page }) => {
  await openChapter(page);
  await expect(page.locator("#rSlider")).toHaveAttribute("max", String(lib.pages - 1));
  await page.locator("#rSlider").fill(String(lib.pages - 1));
  await page.locator("#rSlider").dispatchEvent("change");
  await expect(page.locator("#rCount")).toHaveText(`${lib.pages} / ${lib.pages}`);
});

test("tapping the middle clears the chrome away, and brings it back", async ({ page }) => {
  await openChapter(page);
  const box = await page.locator("#rStage").boundingBox();
  const middle = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await middle();
  await expect(page.locator("#reader")).toHaveClass(/immersive/);
  await middle();
  await expect(page.locator("#reader")).not.toHaveClass(/immersive/);
  // the page did not move while the chrome was being toggled
  await expect(page.locator("#rCount")).toHaveText(`1 / ${lib.pages}`);
});

test("dragging turns the page like paper", async ({ page }) => {
  await openChapter(page);
  const box = await page.locator("#rStage").boundingBox();
  const y = box.y + box.height / 2;

  // right-to-left: dragging leftwards carries the sheet forward
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.12, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);

  // a drag that barely moves falls back to where it started
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.70, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);
});

test("double click zooms in, and again zooms back out", async ({ page }) => {
  await openChapter(page);
  const scale = () => page.evaluate(() => {
    const t = getComputedStyle(document.querySelector("#rBook")).transform;
    return t === "none" ? 1 : new DOMMatrix(t).a;
  });
  expect(await scale()).toBeCloseTo(1, 1);
  const box = await page.locator("#rStage").boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  expect(await scale()).toBeGreaterThan(2);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  expect(await scale()).toBeCloseTo(1, 1);
});

test("the home screen offers to pick up where reading stopped", async ({ page }) => {
  await openChapter(page);
  await turnOn(page);
  await expect(page.locator("#rCount")).toHaveText(`2 / ${lib.pages}`);
  await page.keyboard.press("Escape");

  await expect(page.locator("#resumeCard")).toBeVisible();
  await expect(page.locator("#resumeWhere")).toHaveText("원피스 · 001화");
  await expect(page.locator("#resumePage")).toContainText("2");
});

test("continuous scrolling stacks the pages down the screen", async ({ page }) => {
  const errors = await openChapter(page);
  await openSettings(page);
  await page.click("#rMode");
  await expect(page.locator("#rMode")).toHaveText("이어서 스크롤");
  await page.keyboard.press("Escape");

  await expect(page.locator("#rScroll")).toBeVisible();
  await expect(page.locator("#rBook")).toBeHidden();
  await expect(page.locator("#rScroll .scroll-slot")).toHaveCount(lib.pages);

  // scrolling down moves the page counter with it
  await page.locator("#rScroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator("#rCount")).toHaveText(`${lib.pages} / ${lib.pages}`);

  // and the mode is remembered on the way back to paging
  await openSettings(page);
  await page.click("#rMode");
  await expect(page.locator("#rMode")).toHaveText("책장 넘기기");
  await page.keyboard.press("Escape");
  await expect(page.locator("#rBook")).toBeVisible();
  expect(errors).toEqual([]);
});

// ---------- reading from a repository ----------

/**
 * Stand in for GitHub.
 *
 * The shapes here were checked against the real API before being written down:
 * a tree lists `{path, sha, type}` with a `truncated` flag, and a blob fetched
 * with the raw Accept header comes back as the file's own bytes. Faking it is
 * what makes this path testable at all — the real one needs a credential no
 * test can carry.
 */
function fakeRepo(page, { files, onRequest }) {
  const shaFor = (p) => "sha-" + p.replace(/[^a-z0-9]/gi, "-");
  return page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const url = req.url();
    if (onRequest) onRequest({ url, headers: req.headers() });

    if (url.includes("/user/repos")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: oneRepo() });
    }
    if (url.includes("/git/trees/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          truncated: false,
          tree: files.map((p) => ({ path: p, sha: shaFor(p), type: "blob", mode: "100644" }))
            .concat([{ path: "만화", sha: "sha-dir", type: "tree", mode: "040000" }])
        })
      });
    }
    if (url.includes("/git/blobs/")) {
      const p = files.find((f) => url.endsWith(shaFor(f)));
      if (!p) return route.fulfill({ status: 404, body: "{}" });
      const shade = 40 + (files.indexOf(p) * 37) % 180;
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: makePng(300, 420, ({ rect }) => rect(0, 0, 300, 420, [shade, 90, 130]))
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
}

/** Connecting is one field now: paste the token, the repository is found. */
async function connectRepo(page, token = "github_pat_test") {
  await page.click("#ghToggle");
  await expect(page.locator("#ghPanel")).toBeVisible();
  await page.fill("#ghToken", token);
  await page.click("#ghConnectBtn");
}

/** Answer /user/repos so the token resolves to `someone/my-comics`. */
function oneRepo(names = ["my-comics"]) {
  return JSON.stringify(names.map((n) => ({
    name: n, full_name: "someone/" + n, owner: { login: "someone" }
  })));
}

test("a repository becomes a library, and its pages are read", async ({ page }) => {
  const seen = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await fakeRepo(page, {
    files: [
      "만화/원피스/001화/p01.png", "만화/원피스/001화/p02.png",
      "만화/원피스/002화/p01.png", "만화/나루토/001화/p01.png",
      "만화/원피스/001화/readme.txt"          // not an image; must be ignored
    ],
    onRequest: (r) => seen.push(r)
  });

  await page.goto("/index.html#/library");
  await connectRepo(page);

  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await expect(page.locator("#seriesGrid .series-card")).toHaveCount(2);
  await expect(page.locator("#ghConnected")).toBeVisible();
  await expect(page.locator("#ghRepoList")).toContainText("someone/my-comics");

  // the token travels as a bearer, and pages are asked for as raw bytes
  const tree = seen.find((r) => r.url.includes("/git/trees/"));
  expect(tree.headers.authorization).toBe("Bearer github_pat_test");
  expect(tree.url).toContain("recursive=1");

  await page.locator(".series-card", { hasText: "원피스" }).click();
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(2);
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible({ timeout: 30_000 });
  await forceSingle(page);
  await expect(page.locator("#rCount")).toHaveText("1 / 2");

  const blob = seen.find((r) => r.url.includes("/git/blobs/"));
  expect(blob.headers.accept).toBe("application/vnd.github.raw");
  expect(errors).toEqual([]);
});

test("a token that can reach several repositories offers a choice", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: oneRepo(["my-comics", "other-comics"])
      });
    }
    if (url.includes("/git/trees/")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ truncated: false, tree: [
          { path: "원피스/001화/p01.png", sha: "s1", type: "blob" }
        ] })
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);

  await expect(page.locator("#ghPick")).toBeVisible();
  await expect(page.locator("#ghPickList .repo-row")).toHaveCount(2);
  await page.locator(".repo-row", { hasText: "other-comics" }).click();
  // the list stays open so several can be taken in one pass, ticking what is on
  await expect(page.locator(".repo-row", { hasText: "other-comics" })).toHaveClass(/on/);
  await page.click("#ghPickDone");
  await expect(page.locator("#ghRepoList")).toContainText("someone/other-comics");
});

test("two repositories become one shelf, and either can be dropped", async ({ page }) => {
  // GitHub's size guidance is per repository, so a growing library spreads out.
  // Reading it must not: both repositories have to land on the same shelf.
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: oneRepo(["comics-a", "comics-b"])
      });
    }
    if (url.includes("/git/trees/")) {
      // each repository holds one series at its root, so only the repository
      // name tells them apart — the merge has to keep it
      const one = url.includes("comics-a") ? "원피스" : "나루토";
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ truncated: false, tree: [
          { path: one + "/001화/p01.png", sha: "s-" + one, type: "blob" }
        ] })
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);

  await page.locator(".repo-row", { hasText: "comics-a" }).click();
  await expect(page.locator(".repo-row", { hasText: "comics-a" })).toHaveClass(/on/);
  await page.locator(".repo-row", { hasText: "comics-b" }).click();
  await page.click("#ghPickDone");

  await expect(page.locator("#ghRepoList .repo-line")).toHaveCount(2);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await expect(page.locator("#seriesGrid .series-card")).toHaveCount(2);

  // dropping one leaves the other standing
  await page.locator(".repo-line", { hasText: "comics-a" }).locator(".repo-drop").click();
  await expect(page.locator("#ghRepoList .repo-line")).toHaveCount(1);
  await expect(page.locator("#seriesGrid .series-card")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a series split across two repositories reads as one", async ({ page }) => {
  // 500 chapters do not have to sit in one repository. When they do not, the
  // shelf must not show the same series twice — the split is a storage detail.
  const png = makePng(300, 900, ({ rect }) => rect(0, 0, 300, 900, [70, 70, 70]));
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({
        status: 200, contentType: "application/json", body: oneRepo(["komi-1", "komi-2"])
      });
    }
    if (url.includes("/git/trees/")) {
      // both halves hold several captures: a folder with only one is a chapter
      // folder, not a series, and takes a different path through the regroup
      const half = url.includes("komi-1") ? ["001화", "002화"] : ["300화", "301화"];
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ truncated: false, tree: half.map((n) => (
          { path: "코미/" + n + ".png", sha: "s-" + n, type: "blob" })) })
      });
    }
    if (url.includes("/git/blobs/")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  await page.locator(".repo-row", { hasText: "komi-1" }).click();
  await page.locator(".repo-row", { hasText: "komi-2" }).click();
  await page.click("#ghPickDone");

  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await expect(page.locator("#seriesGrid .series-card")).toHaveCount(1);
  await page.locator(".series-card", { hasText: "코미" }).click();
  // all three chapters, from both repositories, in reading order
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(4);
});

test("one unreadable repository costs one series, not the library", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({
        status: 200, contentType: "application/json", body: oneRepo(["comics-a", "gone"])
      });
    }
    if (url.includes("/git/trees/")) {
      if (url.includes("/gone/")) return route.fulfill({ status: 404, body: "{}" });
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ truncated: false, tree: [
          { path: "원피스/001화/p01.png", sha: "s1", type: "blob" }
        ] })
      });
    }
    if (url.endsWith("/user")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ login: "someone" })
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  await page.locator(".repo-row", { hasText: "comics-a" }).click();
  await page.locator(".repo-row", { hasText: "gone" }).click();
  await page.click("#ghPickDone");

  // the failure is named, and what could be read is still on the shelf
  await expect(page.locator(".toast", { hasText: "someone/gone" })).toBeVisible();
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await expect(page.locator("#seriesGrid .series-card")).toHaveCount(1);
});

test("a token that cannot list repositories asks for the address instead", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) return route.fulfill({ status: 403, body: "[]" });
    if (url.includes("/git/trees/")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ truncated: false, tree: [
          { path: "원피스/001화/p01.png", sha: "s1", type: "blob" }
        ] })
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);

  await expect(page.locator("#ghManual")).toBeVisible();
  // a pasted URL is accepted, not just owner/repo
  await page.fill("#ghRepo", "https://github.com/someone/my-comics");
  await page.click("#ghManualBtn");
  await expect(page.locator("#ghRepoList")).toContainText("someone/my-comics");
});

test("a rejected token says so instead of failing silently", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
  await page.goto("/index.html#/library");
  await connectRepo(page, "wrong");
  await expect(page.locator(".toast")).toContainText("토큰");
  await expect(page.locator("#ghForm")).toBeVisible();      // still asking
});

test("a repository too big to list says what to do about it", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => {
    if (route.request().url().includes("/user/repos")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: oneRepo() });
    }
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ truncated: true, tree: [] })
    });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  await expect(page.locator(".toast")).toContainText("하위 경로");
});

/**
 * The one thing a mock cannot prove: that the request leaves the browser and
 * comes back readable.
 *
 * A deliberately wrong token is enough. Reaching "토큰이 거부됐어요" means the
 * preflight was accepted, the request was sent, and the 401 could be READ —
 * which is exactly what a CORS failure would prevent. Had CORS blocked it,
 * fetch would have thrown a TypeError and the message would be the generic one.
 *
 * Off by default: the suite stays hermetic and does not fail when GitHub does.
 * Run it with LIVE_GITHUB=1.
 */
test("the request really reaches GitHub and the answer comes back", async ({ page }) => {
  test.skip(!process.env.LIVE_GITHUB, "set LIVE_GITHUB=1 to talk to the real API");
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html#/library");
  await connectRepo(page, "github_pat_11ABCDEF_thisIsNotARealToken");
  await expect(page.locator(".toast")).toContainText("토큰이 거부됐어요", { timeout: 30_000 });
  await expect(page.locator("#ghForm")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a pin in another chapter opens that chapter", async ({ page }) => {
  const errors = await openChapter(page);          // 원피스 001화
  await turnOn(page);
  await page.click("#rPin");                       // pin 001화 page 2
  await expect(page.locator("#rPinCount")).toHaveText("1");

  // move to the next chapter and pin there too
  await page.keyboard.press("Escape");
  await page.locator(".chapter-row").nth(1).click();
  await expect(page.locator("#rSub")).toHaveText("002화");
  await page.click("#rPin");
  await expect(page.locator("#rPinCount")).toHaveText("2");

  // from 002화, jump back to the pin that lives in 001화
  await page.click("#rPinList");
  await expect(page.locator("#rPinPanel")).toBeVisible();
  await page.locator("#rPinList2 .pin-row .where", { hasText: "001화" }).first().click();
  await expect(page.locator("#rSub")).toHaveText("001화", { timeout: 30_000 });
  await expect(page.locator("#rCount")).toContainText("2");
  expect(errors).toEqual([]);
});

test("an under-scoped token is told apart from a wrong repository name", async ({ page }) => {
  // GitHub hides a repository a token cannot see behind a 404, so the app has to
  // ask who the token belongs to before it can say what went wrong
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: oneRepo() });
    }
    if (url.endsWith("/user")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ login: "someone" })
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  await expect(page.locator(".toast")).toContainText("Repository access");
  await expect(page.locator("#ghForm")).toBeVisible();
});

test("a token belonging to someone else says whose it is", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: oneRepo() });
    }
    if (url.endsWith("/user")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ login: "other-person" })
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  await expect(page.locator(".toast")).toContainText("other-person");
});

test("a bad name with a dead token falls back to the plain message", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => {
    if (route.request().url().includes("/user/repos")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: oneRepo() });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  await expect(page.locator(".toast")).toContainText("저장소 이름을 확인");
});

test("connecting says what it found, so a wrong repository is obvious", async ({ page }) => {
  await fakeRepo(page, {
    // what the app's own source repository looks like: a few icons, no comics
    files: ["icons/icon-192.png", "icons/icon-512.png"]
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);
  // the app's own repository holds icons, not comics — and now it says so
  await expect(page.locator(".toast")).toContainText("icons");

  // and switching away keeps the token instead of forcing a disconnect
  await page.click("#ghAddBtn");
  // one reachable repository, so it asks for an address rather than a choice
  await expect(page.locator("#ghManual")).toBeVisible();
  await expect(page.locator("#ghForm")).toBeHidden();
});

test("a folder load reports its size too", async ({ page }) => {
  await loadLibrary(page);
  await expect(page.locator(".toast")).toContainText("시리즈");
});

test("a repository missing from the list can still be typed in", async ({ page }) => {
  // the token here reaches two repositories, neither of them the one wanted —
  // the list must not be the only way through
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user/repos")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: oneRepo(["manhwa-trimmer", "something-else"])
      });
    }
    if (url.includes("/git/trees/")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ truncated: false, tree: [
          { path: "코미/001화.png", sha: "s1", type: "blob" }
        ] })
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("/index.html#/library");
  await connectRepo(page);

  await expect(page.locator("#ghPick")).toBeVisible();
  await expect(page.locator("#ghPickList .repo-row")).toHaveCount(2);
  await page.click("#ghPickManual");
  await expect(page.locator("#ghManual")).toBeVisible();
  await page.fill("#ghRepo", "someone/manhwa-library");
  await page.click("#ghManualBtn");
  await expect(page.locator("#ghRepoList")).toContainText("someone/manhwa-library");
});

test("a badly cut capture can be re-cut from the reader", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/index.html#/library");
  await page.setInputFiles("#folderInput", uncut.root);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await page.locator(".series-card", { hasText: "슬램덩크" }).click();
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible({ timeout: 30_000 });
  await forceSingle(page);
  await expect(page.locator("#rCount")).toHaveText(`1 / ${uncut.pages}`, { timeout: 30_000 });

  // the control only exists for captures the app cut itself
  await openSettings(page);
  await expect(page.locator("#rSplitRow")).toBeVisible();
  await expect(page.locator("#rSplitN")).toHaveText(String(uncut.pages));

  await page.click("#rSplitUp");
  await expect(page.locator("#rSplitN")).toHaveText(String(uncut.pages + 1));
  await expect(page.locator("#rCount")).toContainText("/ " + (uncut.pages + 1));

  await page.click("#rSplitAuto");
  await expect(page.locator("#rSplitN")).toHaveText(String(uncut.pages));
  expect(errors).toEqual([]);
});

test("a folder of ready pages offers no re-cutting", async ({ page }) => {
  await openChapter(page);          // 원피스 001화, already separate images
  await openSettings(page);
  await expect(page.locator("#rSplitRow")).toBeHidden();
});

// ---------- the shelf ----------

test("chapters can be searched and filtered by what has been read", async ({ page }) => {
  const errors = await loadLibrary(page);
  await page.locator(".series-card", { hasText: "원피스" }).click();
  await expect(page.locator("#shelfTools")).toBeVisible();
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(2);

  // typing a number finds the chapter however it was named
  await page.fill("#chapSearch", "2");
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(1);
  await expect(page.locator(".chapter-row .ch-name")).toHaveText("002화");
  await page.fill("#chapSearch", "99");
  await expect(page.locator("#chapterList")).toContainText("찾지 못했어요");
  await page.fill("#chapSearch", "");

  // read one chapter to the end
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await forceSingle(page);
  for (let i = 0; i < lib.pages - 1; i++) await turnOn(page);
  await expect(page.locator("#rCount")).toHaveText(`${lib.pages} / ${lib.pages}`);
  await page.keyboard.press("Escape");

  await expect(page.locator(".chapter-row.done .ch-name")).toHaveText("001화");
  await page.click('.chip[data-status="unread"]');
  await expect(page.locator("#chapterList .chapter-row")).toHaveCount(1);
  await expect(page.locator(".chapter-row .ch-name")).toHaveText("002화");
  await page.click('.chip[data-status="done"]');
  await expect(page.locator(".chapter-row .ch-name")).toHaveText("001화");
  expect(errors).toEqual([]);
});

test("continue opens the first chapter that is not finished", async ({ page }) => {
  await loadLibrary(page);
  await page.locator(".series-card", { hasText: "원피스" }).click();
  await expect(page.locator("#continueBtn")).toContainText("001화");

  await page.locator(".chapter-row").first().click();
  await forceSingle(page);
  for (let i = 0; i < lib.pages - 1; i++) await turnOn(page);
  await page.keyboard.press("Escape");

  // chapter one is finished, so continue now points at chapter two
  await expect(page.locator("#continueBtn")).toContainText("002화");
  await page.click("#continueBtn");
  await expect(page.locator("#rSub")).toHaveText("002화");
});

test("what has been read survives a reload", async ({ page }) => {
  await loadLibrary(page);
  await page.locator(".series-card", { hasText: "원피스" }).click();
  await page.locator(".chapter-row").first().click();
  await forceSingle(page);
  for (let i = 0; i < lib.pages - 1; i++) await turnOn(page);
  await page.keyboard.press("Escape");
  // settled before reloading: a reload mid-turn is testing the browser, not this
  await expect(page.locator(".chapter-row.done .ch-name")).toHaveText("001화");

  await page.reload();
  await page.setInputFiles("#folderInput", lib.root);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await expect(page.locator(".series-card", { hasText: "원피스" })).toContainText("읽음");
  await page.locator(".series-card", { hasText: "원피스" }).click();
  await expect(page.locator(".chapter-row.done .ch-name")).toHaveText("001화");
});

test("a measured capture is not measured again on the next visit", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html#/library");
  await page.setInputFiles("#folderInput", uncut.root);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await page.locator(".series-card", { hasText: "슬램덩크" }).click();
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#reader")).toBeVisible({ timeout: 30_000 });
  await forceSingle(page);
  await expect(page.locator("#rCount")).toHaveText(`1 / ${uncut.pages}`, { timeout: 30_000 });
  await page.keyboard.press("Escape");

  const kept = await page.evaluate(() => localStorage.getItem("manhwa-cuts"));
  expect(kept).toContain("슬램덩크");

  // a fresh page still opens it at the same cut, without measuring again
  await page.reload();
  await page.setInputFiles("#folderInput", uncut.root);
  await page.waitForSelector("#libBody:not([hidden])", { timeout: 30_000 });
  await page.locator(".series-card", { hasText: "슬램덩크" }).click();
  await expect(page.locator(".chapter-row").first()).toContainText(`${uncut.pages}쪽`);
  await page.locator(".chapter-row").first().click();
  await expect(page.locator("#rCount")).toHaveText(`1 / ${uncut.pages}`, { timeout: 15_000 });
  expect(errors).toEqual([]);
});
