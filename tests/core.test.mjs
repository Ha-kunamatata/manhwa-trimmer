import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStats } from "./fixtures.mjs";
import {
  detectColumns, buildBandMap, computePages, autoFit, findBlankBands
} from "../src/core/geometry.js";
import { buildPdf } from "../src/core/pdf.js";

const strip = (over = {}) => makeStats({
  width: 900, colLeft: 160, colRight: 740, top: 200,
  pageHeights: Array(9).fill(820), gutter: 30, panels: 4, ...over
});

test("detectColumns finds the printed page column", () => {
  const { stats } = strip();
  const { left, right } = detectColumns(stats);
  assert.ok(Math.abs(left - 160) <= stats.colStep * 2, `left ${left}`);
  assert.ok(Math.abs(right - 740) <= stats.colStep * 2, `right ${right}`);
});

test("detectColumns ignores floating buttons beside the page", () => {
  // buttons sit right of the column on a handful of rows; taking first-to-last
  // inked column would drag the right edge into the blank margin
  const { stats } = strip({ sideButtons: [260, 300, 340, 380, 420] });
  const { right } = detectColumns(stats);
  assert.ok(right <= 740 + stats.colStep * 2, `right edge ran into the margin: ${right}`);
});

test("computePages returns the requested page count and covers the whole strip", () => {
  const { stats, box } = strip();
  const bands = buildBandMap(stats, box);
  const { pages } = computePages({
    bx: box, offset: 0, pageHeight: box.width * 1.4142, pageCount: 9,
    bands, height: stats.height
  });
  assert.equal(pages.length, 9);
  const covered = pages.reduce((a, p) => a + p.height, 0);
  assert.ok(Math.abs(covered - box.height) <= 2, `covered ${covered} of ${box.height}`);
});

test("page breaks land on the real margins, not on an even division", () => {
  const { stats, box, boundaries } = strip();
  const bands = buildBandMap(stats, box);
  const { cuts } = computePages({
    bx: box, offset: 0, pageHeight: box.width * 1.4142, pageCount: 9,
    bands, height: stats.height
  });
  assert.equal(cuts.length, boundaries.length);
  const worst = Math.max(...cuts.map((c, i) => Math.abs(c.y - boundaries[i])));
  assert.ok(worst <= 6, `worst break was ${worst}px from the margin centre`);
});

test("uneven page heights do not accumulate drift", () => {
  const heights = [820, 760, 880, 800, 900, 740, 860, 820, 780];
  const { stats, box, boundaries } = strip({ pageHeights: heights });
  const bands = buildBandMap(stats, box);
  const { cuts } = computePages({
    bx: box, offset: 0, pageHeight: box.width * 1.4142, pageCount: heights.length,
    bands, height: stats.height
  });
  const worst = Math.max(...cuts.map((c, i) => Math.abs(c.y - boundaries[i])));
  assert.ok(worst <= 8, `drifted ${worst}px by the end of the strip`);
});

test("autoFit reads a single-page layout", () => {
  const { stats, box } = strip();
  const bands = buildBandMap(stats, box);
  const fit = autoFit(box, 0, bands, stats.height);
  assert.ok(fit, "no fit found");
  assert.equal(fit.across, 1);
  assert.equal(fit.n, 9);
});

test("autoFit reads a two-page spread", () => {
  // a spread is twice as wide, so each row of the strip holds two leaves
  const { stats, box } = makeStats({
    width: 1500, colLeft: 150, colRight: 1350, top: 200,
    pageHeights: Array(8).fill(848), gutter: 30, panels: 4
  });
  const bands = buildBandMap(stats, box);
  const fit = autoFit(box, 0, bands, stats.height);
  assert.ok(fit, "no fit found");
  assert.equal(fit.across, 2, `read as ${fit.across}-across`);
  assert.equal(fit.n, 8);
});

test("manual edits add and remove breaks", () => {
  const { stats, box } = strip();
  const bands = buildBandMap(stats, box);
  const base = computePages({ bx: box, offset: 0, pageHeight: box.width * 1.4142,
    pageCount: 9, bands, height: stats.height });
  const removed = computePages({ bx: box, offset: 0, pageHeight: box.width * 1.4142,
    pageCount: 9, bands, height: stats.height, manualRemoves: [base.cuts[3].y] });
  assert.equal(removed.cuts.length, base.cuts.length - 1);

  const mid = Math.round((base.cuts[0].y + base.cuts[1].y) / 2);
  const added = computePages({ bx: box, offset: 0, pageHeight: box.width * 1.4142,
    pageCount: 9, bands, height: stats.height, manualAdds: [mid] });
  assert.equal(added.cuts.length, base.cuts.length + 1);
  assert.ok(added.cuts.some((c) => c.manual));
});

test("findBlankBands reports the margins between pages", () => {
  const { stats, box, boundaries } = strip();
  const bands = findBlankBands(stats, box);
  for (const b of boundaries) {
    assert.ok(bands.some((y) => Math.abs(y - b) <= 6), `no band near ${b}`);
  }
});

test("buildPdf emits a valid document with one page per image", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  const pdf = buildPdf([
    { bytes: jpeg, w: 600, h: 848 },
    { bytes: jpeg, w: 600, h: 848 },
    { bytes: jpeg, w: 600, h: 848 }
  ]);
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"), "missing PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "missing EOF marker");
  assert.equal((text.match(/\/Type \/Page[^s]/g) || []).length, 3);
  assert.ok(text.includes("/Filter /DCTDecode"), "images are not JPEG streams");
  assert.ok(text.includes("xref"), "missing xref table");
});
