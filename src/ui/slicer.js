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
export async function sliceFile(blob, onProgress) {
  const img = await decodeBlob(blob);
  const w = img.width, h = img.height;
  try {
    if (!looksLikeStrip(w, h)) return [{ sx: 0, sy: 0, sw: w, sh: h }];

    const canvas = toCanvas(img);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const stats = await analyseStrip(ctx, w, h, { onProgress, yieldFn: idle });
    const bx = detectBox(stats, w, h);
    const plan = planPages(stats, bx, h);
    if (!plan.pages.length) return [{ sx: 0, sy: 0, sw: w, sh: h }];
    return plan.pages.map((p) => ({
      sx: bx.left, sy: p.start, sw: bx.width, sh: p.height
    }));
  } catch (err) {
    // an image too big to measure is still an image; show it whole rather than
    // dropping the chapter on the floor
    return [{ sx: 0, sy: 0, sw: w, sh: h }];
  } finally {
    if (img.close) img.close();
  }
}

/**
 * Plan a whole chapter: every file's rectangles, in order, tagged with the file
 * they belong to. `onStep(done, total, name)` reports progress between files.
 */
export async function sliceChapter(items, onStep) {
  const pages = [];
  for (let i = 0; i < items.length; i++) {
    if (onStep) onStep(i, items.length, items[i].name);
    const blob = await items[i].load();
    const rects = await sliceFile(blob, null);
    for (const r of rects) pages.push({ file: i, ...r });
  }
  if (onStep) onStep(items.length, items.length, null);
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
