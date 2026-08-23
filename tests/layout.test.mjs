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
