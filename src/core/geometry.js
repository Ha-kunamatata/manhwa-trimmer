/**
 * Pure layout geometry. Everything here takes plain data and returns plain
 * data, so it can be unit-tested without a browser.
 *
 * The guiding idea: a comic page has a standard proportion (B6/A5 tankoubon
 * is 1 : 1.414). Use that as the guide to decide how many pages a strip holds
 * and roughly where they break, then snap each break onto the real margin.
 */

export const RATIOS = [1.4142, 1.5, 1.3];

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Locate the printed page column.
 *
 * Taking "first inked column to last inked column" is wrong: floating site
 * buttons beside the page are inked too, and they stretch the column into the
 * blank margin. A page carries ink on most rows while a floating button
 * carries ink on a few, so take the widest RUN of columns above a density
 * threshold instead.
 */
export function detectColumns({ colInk, colStep, grayRows, width }) {
  let left = 0, right = width;
  if (colInk && grayRows > 20) {
    const n = colInk.length;
    const frac = new Float64Array(n);
    let maxFrac = 0;
    for (let i = 0; i < n; i++) {
      frac[i] = colInk[i] / grayRows;
      if (frac[i] > maxFrac) maxFrac = frac[i];
    }
    if (maxFrac > 0.02) {
      const thr = maxFrac * 0.25;
      let bs = -1, be = -1, cs = -1;
      for (let i = 0; i < n; i++) {
        if (frac[i] >= thr) { if (cs < 0) cs = i; }
        else if (cs >= 0) { if (i - cs > be - bs) { bs = cs; be = i; } cs = -1; }
      }
      if (cs >= 0 && n - cs > be - bs) { bs = cs; be = n; }
      if (bs >= 0 && (be - bs) * colStep >= width * 0.2) {
        left = bs * colStep;
        right = Math.min(width, be * colStep);
      }
    }
  }
  return { left, right, cropLeft: left, cropRight: width - right };
}

/**
 * Find the vertical extent of the comic by trimming site chrome off each end.
 *
 * Colour used to be the whole test — the comic is grayscale, the ads are not —
 * and it ate every chapter that opens on a colour cover. A cover is saturated
 * for its entire height, so "crop down to the last coloured row" cropped away
 * the cover itself, which is the one page a reader most wants to see.
 *
 * What actually separates them is shape, not colour. A banner is a thin band; a
 * printed page is a page. So a coloured run is measured, and only the short ones
 * are chrome. `pageWidth` sets the scale — without it there is no way to say how
 * tall "thin" is.
 *
 * The bias is deliberate: an unusually tall banner survives as content, and that
 * is the cheaper mistake. A stray ad can be trimmed by hand in the editor; a
 * cover eaten before it is ever displayed just looks like a missing page.
 */
export function detectRows({ variance, saturation, height, pageWidth = 0 }) {
  const scan = Math.round(Math.min(height * 0.35, 4000));
  const chromeMax = pageWidth > 0 ? pageWidth * 0.55 : height * 0.08;

  let top = edgeChrome({ variance, saturation }, 0, 1, scan, chromeMax);
  let bottom = edgeChrome({ variance, saturation }, height - 1, -1, scan, chromeMax);

  while (top < height - 1 && Math.sqrt(variance[top]) < 6) top++;
  while (bottom < height - 1 && Math.sqrt(variance[height - 1 - bottom]) < 6) bottom++;

  return { top, bottom };
}

/**
 * How many rows of site chrome sit at one end of the strip.
 *
 * Walks inwards: blank paper is passed over, a short coloured run is stepped
 * past as a banner, and anything else — grey printed content, or a coloured run
 * too tall to be a banner — stops the walk.
 */
function edgeChrome({ variance, saturation }, start, step, scan, chromeMax) {
  const coloured = (y) => saturation[y] > 22;
  const inked = (y) => Math.sqrt(variance[y]) >= 6;
  const GAP = 14;                 // blank rows tolerated inside one banner
  let depth = 0;

  while (depth < scan) {
    const y = start + step * depth;
    if (!coloured(y)) {
      if (inked(y)) break;        // grey printed content: the comic starts here
      depth++;                    // blank margin, keep going
      continue;
    }
    // measure the coloured run this row belongs to. Remembering where colour
    // was last seen is what keeps the blank tail out of the count — subtracting
    // the gap afterwards leaves the run a row short and the walk stuck on it.
    let run = 0, gap = 0, last = -1;
    while (depth + run < scan) {
      const yy = start + step * (depth + run);
      if (coloured(yy)) { gap = 0; last = run; }
      else if (++gap > GAP) break;
      run++;
    }
    const band = last + 1;
    if (band <= 0 || band > chromeMax) break;   // a coloured PAGE, not a banner
    depth += band;
  }
  return depth;
}

/**
 * Thickness of the blank band each row belongs to.
 *
 * The margin between two printed pages is a thick white band; the gap between
 * panels inside a page is thin. Thickness is the only reliable way to tell a
 * page break from a panel gap.
 */
export function buildBandMap({ brightness, variance, height }, bx) {
  const thick = new Int32Array(height);
  const sizes = [];
  let run = -1;
  const flush = (a, b) => {
    const t = b - a;
    if (t > 0) { sizes.push(t); for (let y = a; y < b; y++) thick[y] = t; }
  };
  for (let y = bx.top; y < bx.bottom; y++) {
    const blank = brightness[y] >= 232 && Math.sqrt(variance[y]) <= 18;
    if (blank) { if (run < 0) run = y; }
    else if (run >= 0) { flush(run, y); run = -1; }
  }
  if (run >= 0) flush(run, bx.bottom);
  sizes.sort((a, b) => a - b);
  const ref = sizes.length ? Math.max(4, sizes[Math.floor(sizes.length * 0.9)]) : 4;
  return { thick, ref };
}

/** Midpoints of blank runs, used to snap a hand-placed line into a margin. */
export function findBlankBands({ brightness, variance }, bx) {
  const out = [];
  let run = -1;
  for (let y = bx.top; y < bx.bottom; y++) {
    const blank = brightness[y] >= 235 && Math.sqrt(variance[y]) <= 16;
    if (blank) { if (run < 0) run = y; }
    else if (run >= 0) { if (y - run >= 6) out.push(Math.round((run + y) / 2)); run = -1; }
  }
  if (run >= 0 && bx.bottom - run >= 6) out.push(Math.round((run + bx.bottom) / 2));
  return out;
}

/** Pull a grid line onto the centre of the nearest convincing blank band. */
export function snapToBand(y, h, bx, bands) {
  const t = bands && bands.thick;
  if (!t) return y;
  const range = Math.max(8, Math.round(h * 0.18));
  let bestY = -1, bestT = 0, bestD = Infinity;
  for (let d = -range; d <= range; d++) {
    const yy = y + d;
    if (yy <= bx.top || yy >= bx.bottom) continue;
    const th = t[yy];
    if (th > bestT || (th === bestT && Math.abs(d) < bestD)) { bestT = th; bestY = yy; bestD = Math.abs(d); }
  }
  if (bestY < 0 || bestT < bands.ref * 0.4) return y;   // a panel gap is not a page break
  let a = bestY, b = bestY;
  while (a > bx.top && t[a - 1] === bestT) a--;
  while (b < bx.bottom - 1 && t[b + 1] === bestT) b++;
  return Math.round((a + b) / 2);
}

export function gutterScore(bands, y, height) {
  const t = bands && bands.thick;
  if (!t || y < 0 || y >= height) return 0;
  return clamp(t[y] / bands.ref, 0, 1);
}

/**
 * Pick the page layout by trying each shape the standard geometry allows.
 *
 * A scan may hold one page or a two-page spread, so the page height is either
 * width x ratio or (width / 2) x ratio. Rather than assume, lay every
 * candidate grid over the image and keep the one whose boundaries actually
 * land in margins.
 */
export function autoFit(bx, offset, bands, height) {
  const span = bx.height - offset;
  const start = bx.top + offset;
  if (span < 40) return null;

  const cands = [];
  for (const across of [1, 2]) {
    for (const r of RATIOS) {
      const ideal = (bx.width / across) * r;
      const base = span / ideal;
      if (base < 0.5) continue;
      for (const dn of [-1, 0, 1]) {
        const n = Math.round(base) + dn;
        if (n < 1 || n > 400) continue;
        const h = span / n;
        if (h < ideal * 0.75 || h > ideal * 1.25) continue;   // must honour the geometry it claims
        let sum = 0;
        const search = Math.max(2, Math.round(h * 0.03));
        for (let k = 1; k < n; k++) {
          const y = Math.round(start + k * h);
          let best = 0;
          for (let d = -search; d <= search; d++) best = Math.max(best, gutterScore(bands, y + d, height));
          sum += best;
        }
        cands.push({ n, across, ratio: r, height: h, score: n > 1 ? sum / (n - 1) : 0 });
      }
    }
  }
  if (!cands.length) return null;
  const top = cands.reduce((a, b) => (b.score > a.score ? b : a));
  // A grid at twice the true pitch lands on margins just as cleanly, so among
  // equally good fits take the finest — that one is the real page.
  const tied = cands.filter((c) => c.score >= top.score * 0.95);
  return tied.reduce((a, b) => (b.n > a.n ? b : a));
}

/**
 * Turn the guide into actual page rectangles.
 *
 * A strip is page/margin/page/margin..., so an even division of the whole span
 * can never sit on every margin centre — it is off by up to half a margin,
 * worst at the two ends. So each line is snapped onto the real margin, and the
 * next line is measured from where the previous one actually landed, which
 * stops drift accumulating when pages are not all the same height.
 */
export function computePages({ bx, offset, pageHeight, pageCount, bands, height, manualAdds = [], manualRemoves = [] }) {
  const span = bx.height - offset;
  const start = bx.top + offset;
  const n = clamp(pageCount || Math.max(1, Math.round(span / pageHeight)), 1, 500);
  const actualH = span / n;

  let cuts = [];
  let pos = start;
  for (let k = 1; k < n; k++) {
    const y = snapToBand(Math.round(pos + actualH), actualH, bx, bands);
    cuts.push({ y });
    pos = y;
  }

  const tol = Math.max(12, actualH * 0.02);
  cuts = cuts.filter((c) => !manualRemoves.some((r) => Math.abs(r - c.y) <= tol));
  for (const y of manualAdds) {
    if (y > bx.top && y < bx.bottom && !cuts.some((c) => Math.abs(c.y - y) <= tol)) {
      cuts.push({ y, manual: true });
    }
  }
  cuts.sort((a, b) => a.y - b.y);

  const pages = [];
  let s = start;
  for (const c of cuts) { pages.push({ start: s, end: c.y, height: c.y - s }); s = c.y; }
  pages.push({ start: s, end: bx.bottom, height: bx.bottom - s });

  return { cuts, pages: pages.filter((p) => p.height > 4), n, actualH };
}
