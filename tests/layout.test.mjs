import test from "node:test";
import assert from "node:assert/strict";
import { makeStats } from "./fixtures.mjs";
import { detectBox, boxFrom, planPages, looksLikeStrip } from "../src/core/layout.js";

/** A nine-page capture with floating site buttons beside the printed column. */
const strip = () => makeStats({
  width: 900, colLeft: 160, colRight: 740, top: 220,
  pageHeights: Array(9).fill(820), gutter: 30, panels: 4,
  sideButtons: [300, 301, 302, 900, 901]
});

test("detectBox finds the printed column and skips the chrome", () => {
  const f = strip();
  const bx = detectBox(f.stats, 900, f.height);
  assert.ok(bx.left >= 100 && bx.left <= 200, "left margin " + bx.left);
  assert.ok(bx.right >= 700 && bx.right <= 800, "right edge " + bx.right);
  assert.ok(bx.top >= 200, "top " + bx.top);
  assert.ok(bx.width > 400);
});

test("planPages reads the page count off an unmarked capture", () => {
  const f = strip();
  const bx = detectBox(f.stats, 900, f.height);
  const plan = planPages(f.stats, bx, f.height);
  assert.equal(plan.pageCount, 9);
  assert.equal(plan.pages.length, 9);
  assert.ok(plan.fit, "auto fit should have chosen a format");
});

test("page breaks land on the real margins", () => {
  const f = strip();
  const plan = planPages(f.stats, f.box, f.height);
  assert.equal(plan.cuts.length, f.boundaries.length);
  plan.cuts.forEach((c, i) => {
    assert.ok(Math.abs(c.y - f.boundaries[i]) <= 20,
      `cut ${i} at ${c.y}, margin centre ${f.boundaries[i]}`);
  });
});

test("a fixed ratio divides by geometry instead of fitting", () => {
  const f = strip();
  const plan = planPages(f.stats, f.box, f.height, { ratio: 1.4142 });
  assert.equal(plan.fit, null);
  assert.ok(Math.abs(plan.pageHeight - f.box.width * 1.4142) < 0.001);
});

test("an explicit page count wins over the fitted one", () => {
  const f = strip();
  const plan = planPages(f.stats, f.box, f.height, { pageCount: 4 });
  assert.equal(plan.pages.length, 4);
});

test("boxFrom never lets the margins invert", () => {
  const bx = boxFrom(900, 900, 900, 900, 400, 400);
  assert.ok(bx.width > 0 && bx.height > 0);
  assert.ok(bx.right > bx.left && bx.bottom > bx.top);
});

test("a strip is told apart from a single page", () => {
  // a printed page runs about 1 : 1.3 to 1 : 1.6, so the line sits well clear of
  // anything that could be one page — slicing a page by mistake is the bad way
  // to be wrong, and the reader would rather leave a short strip whole
  assert.equal(looksLikeStrip(800, 1131), false);   // one page, 1 : 1.414
  assert.equal(looksLikeStrip(1600, 1131), false);  // a two-page spread
  assert.equal(looksLikeStrip(800, 1440), false);   // a generously tall page
  assert.equal(looksLikeStrip(800, 8000), true);    // a long capture
  assert.equal(looksLikeStrip(0, 8000), false);     // nothing to divide by
});

// ---------- site chrome vs. a colour cover ----------

const withCover = (extra) => makeStats({
  width: 900, colLeft: 160, colRight: 740, top: 220,
  pageHeights: Array(6).fill(820), gutter: 30, panels: 4, ...extra
});

test("a colour banner above the comic is trimmed away", () => {
  const f = withCover({ topBanner: 180 });
  const bx = detectBox(f.stats, 900, f.height);
  assert.ok(bx.top >= 188, "the banner should be gone, top was " + bx.top);
  assert.ok(bx.top <= 240, "but not the first page, top was " + bx.top);
});

test("a colour cover survives the banner above it", () => {
  // the bug this was written for: a cover is saturated for its whole height, so
  // cropping to the last coloured row ate the cover along with the banner
  const f = withCover({ topBanner: 180, colourPages: [0] });
  const bx = detectBox(f.stats, 900, f.height);
  assert.ok(bx.top >= 188, "the banner should still go, top was " + bx.top);
  assert.ok(bx.top <= 240,
    "the colour cover must survive — top was " + bx.top + ", the cover starts at 220");
});

test("a chapter that opens straight onto a colour cover loses nothing", () => {
  const f = withCover({ colourPages: [0] });
  const bx = detectBox(f.stats, 900, f.height);
  assert.ok(bx.top <= 240, "nothing to trim, yet top was " + bx.top);
});

test("a colour cover still splits into the right number of pages", () => {
  const f = withCover({ topBanner: 180, colourPages: [0] });
  const bx = detectBox(f.stats, 900, f.height);
  const plan = planPages(f.stats, bx, f.height);
  assert.equal(plan.pages.length, 6, "the cover must be one of the pages");
});

test("a colour banner below the comic is trimmed too", () => {
  const f = withCover({ bottomBanner: 200, bottomPad: 240 });
  const bx = detectBox(f.stats, 900, f.height);
  assert.ok(f.height - bx.bottom >= 200, "the bottom banner should go");
});

test("several stacked banners all go, and the cover still does not", () => {
  const f = makeStats({
    width: 900, colLeft: 160, colRight: 740, top: 420,
    pageHeights: Array(4).fill(820), gutter: 30, panels: 4,
    topBanner: 150, colourPages: [0]
  });
  // a second banner, sitting in the gap below the first
  for (let y = 200; y < 340; y++) {
    f.stats.saturation[y] = 60; f.stats.brightness[y] = 120; f.stats.variance[y] = 1200;
  }
  const bx = detectBox(f.stats, 900, f.height);
  assert.ok(bx.top >= 340, "both banners should go, top was " + bx.top);
  assert.ok(bx.top <= 440, "the cover must survive, top was " + bx.top);
});
