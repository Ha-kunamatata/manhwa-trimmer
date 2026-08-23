/**
 * Deciding where the pages are.
 *
 * This is the whole judgement the trimmer makes, in two steps, with no DOM and
 * no controls attached — because the reader needs exactly the same judgement.
 * An uncut capture opened in the viewer has to be cut the same way the editor
 * would cut it, and the only way to be sure of that is for both to call this.
 *
 *   detectBox   where the comic sits inside the capture
 *   planPages   where that area breaks into pages
 *
 * They are separate because they cost different amounts. Measuring the image is
 * slow and happens once; laying out pages is cheap and happens on every nudge of
 * a control, so it must not drag the measurement along with it.
 */
import {
  detectColumns, detectRows, buildBandMap, autoFit, computePages, clamp
} from "./geometry.js";

/** The comic's rectangle inside the capture, with the site's chrome trimmed off. */
export function detectBox(stats, width, height) {
  const cols = detectColumns({
    colInk: stats.colInk, colStep: stats.colStep,
    grayRows: stats.grayRows, width
  });
  const rows = detectRows({
    variance: stats.variance, saturation: stats.saturation, height
  });
  return boxFrom(cols.cropLeft, cols.cropRight, rows.top, rows.bottom, width, height);
}

/** Build the box from four margins, clamped so it can never invert. */
export function boxFrom(left, right, top, bottom, width, height) {
  const l = clamp(left, 0, width - 10);
  const r = clamp(right, 0, width - l - 10);
  const t = clamp(top, 0, height - 10);
  const b = clamp(bottom, 0, height - t - 10);
  return { left: l, right: width - r, top: t, bottom: height - b, width: width - l - r, height: height - t - b };
}

/**
 * Lay out the pages inside `bx`.
 *
 * With no `ratio`, the format is chosen by trying the standard candidates
 * against the image and scoring where the breaks land. Pass a ratio to override
 * that and divide by geometry alone.
 */
export function planPages(stats, bx, height, opts = {}) {
  const {
    offset = 0, ratio = null, pageCount = null,
    manualAdds = [], manualRemoves = []
  } = opts;

  const bands = buildBandMap(
    { brightness: stats.brightness, variance: stats.variance, height }, bx);
  const fit = ratio == null ? autoFit(bx, offset, bands, height) : null;
  const pageHeight = fit ? fit.height : bx.width * ratio;
  const n = clamp(
    pageCount || (fit ? fit.n : Math.max(1, Math.round((bx.height - offset) / pageHeight))),
    1, 500);

  const built = computePages({
    bx, offset, pageHeight, pageCount: n, bands, height, manualAdds, manualRemoves
  });
  return {
    bands, fit, pageHeight,
    pageCount: n,
    cuts: built.cuts,
    pages: built.pages,
    actualH: built.actualH
  };
}

/**
 * Does this image look like a long capture rather than a single page?
 *
 * A printed page is about 1 : 1.414, and a two-page spread is wider still. Even
 * a generous single page never approaches twice its width, so anything taller
 * than that is a strip holding several pages. The threshold is deliberately far
 * from the page ratio: mistaking a page for a strip would slice it up, and that
 * is worse than leaving a short strip whole.
 */
export function looksLikeStrip(width, height) {
  return width > 0 && height / width >= 2.2;
}
