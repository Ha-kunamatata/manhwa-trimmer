/**
 * Cutting uncut captures, for the reader.
 *
 * A folder does not have to hold pages. It very often holds what came off the
 * screen: one enormous image per chapter, site chrome and all. The reader
 * refuses to treat those as pages — it runs them through the same judgement the
 * editor makes (../core/layout.js) and reads the result as a book.
 *
 * The decoded capture is deliberately not kept. A long strip costs tens of
 * megabytes as pixels, and a chapter may hold several, so what survives here is
 * only the plan: a list of rectangles. Pages are drawn later by re-opening the
 * file, with the source holding at most a couple of them at a time.
 */
import { analyseStrip } from "../core/analysis.js";
import { detectBox, planPages, looksLikeStrip } from "../core/layout.js";
import { decodeBlob } from "./sources.js";

/** Draw a decoded image onto a canvas that can be read back. */
export function toCanvas(img) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
  return c;
}

const idle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Work out where the pages are in one file.
 *
 * Returns rectangles in the file's own pixels. A file that is not a strip — an
 * already-cut page sitting in the same folder — yields itself, unchanged, so a
 * mixed folder reads correctly without the caller having to sort it out.
 */
export async function measureFile(blob, onProgress) {
  const img = await decodeBlob(blob);
  const w = img.width, h = img.height;
  try {
    if (!looksLikeStrip(w, h)) return { w, h, stats: null, box: null };
    const canvas = toCanvas(img);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const stats = await analyseStrip(ctx, w, h, { onProgress, yieldFn: idle });
    return { w, h, stats, box: detectBox(stats, w, h) };
  } catch (err) {
    // an image too big to measure is still an image; show it whole rather than
    // dropping the chapter on the floor
    return { w, h, stats: null, box: null };
  } finally {
    if (img.close) img.close();
  }
}

/**
 * Rectangles from a measurement, with no image work at all.
 *
 * Kept apart from measuring so the page count can be argued with. Automatic
 * detection is right most of the time and wrong some of the time, and when it is
 * wrong the reader needs to say "no, twelve pages" and see it immediately —
 * re-measuring a forty-thousand-pixel capture for every nudge would make that
 * unusable.
 */
export function rectsFrom(m, opts) {
  if (!m || !m.stats) return [{ sx: 0, sy: 0, sw: m ? m.w : 1, sh: m ? m.h : 1 }];
  const plan = planPages(m.stats, m.box, m.h, opts || {});
  if (!plan.pages.length) return [{ sx: 0, sy: 0, sw: m.w, sh: m.h }];
  return plan.pages.map((p) => ({
    sx: m.box.left, sy: p.start, sw: m.box.width, sh: p.height
  }));
}

/** How many pages the format suggested, before anyone argued with it. */
export function autoCount(m) {
  return m && m.stats ? rectsFrom(m).length : 1;
}

export async function sliceFile(blob, onProgress) {
  return rectsFrom(await measureFile(blob, onProgress));
}

/**
 * Plan a whole chapter: every file's rectangles, in order, tagged with the file
 * they belong to. `onStep(done, total, name)` reports progress between files.
 */
export async function sliceChapter(items, onStep) {
  const measures = [];
  for (let i = 0; i < items.length; i++) {
    if (onStep) onStep(i, items.length, items[i].name);
    measures.push(await measureFile(await items[i].load(), null));
  }
  if (onStep) onStep(items.length, items.length, null);
  return { measures, pages: pagesFrom(measures) };
}

/** Lay every file's rectangles end to end, tagged with the file they came from. */
export function pagesFrom(measures, opts) {
  const pages = [];
  measures.forEach((m, i) => {
    for (const r of rectsFrom(m, opts)) pages.push({ file: i, ...r });
  });
  return pages;
}

/** Is the first image in this chapter an uncut capture? One decode, no analysis. */
export async function probeIsStrip(item) {
  try {
    const img = await decodeBlob(await item.load());
    const strip = looksLikeStrip(img.width, img.height);
    if (img.close) img.close();
    return strip;
  } catch (err) {
    return false;
  }
}
