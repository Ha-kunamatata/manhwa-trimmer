/**
 * Synthetic strips for tests — no image library needed.
 *
 * `makeStats` builds the same per-row/per-column statistics `analyseStrip`
 * would produce, so the pure geometry can be tested on its own.
 * `makePng` writes a real PNG for the browser tests.
 */
import { deflateSync } from "node:zlib";

/**
 * @param {object} o
 * @param {number} o.width        image width
 * @param {number} o.colLeft      left edge of the printed column
 * @param {number} o.colRight     right edge of the printed column
 * @param {number} o.top          first content row
 * @param {number[]} o.pageHeights heights of each printed page
 * @param {number} o.gutter       blank rows between pages
 * @param {number} o.panels       panels per page (thin gaps between them)
 * @param {number} [o.bottomPad]  blank rows after the last page
 * @param {number[]} [o.sideButtons] rows occupied by floating buttons right of the page
 */
export function makeStats(o) {
  const { width, colLeft, colRight, top, pageHeights, gutter, panels } = o;
  const bottomPad = o.bottomPad ?? 60;
  const height = top + pageHeights.reduce((a, b) => a + b, 0) + gutter * (pageHeights.length - 1) + bottomPad;

  const brightness = new Float32Array(height).fill(255);
  const variance = new Float32Array(height).fill(0);
  const saturation = new Float32Array(height).fill(0);
  const colStep = Math.max(1, Math.floor(width / 400));
  const nCols = Math.ceil(width / colStep);
  const colInk = new Int32Array(nCols);
  let grayRows = 0;

  const boundaries = [];
  let y = top;
  for (let p = 0; p < pageHeights.length; p++) {
    const ph = pageHeights[p];
    const panelH = Math.floor(ph / panels);
    for (let k = 0; k < panels; k++) {
      const a = y + k * panelH + 4;              // 4px thin gap before each panel
      const b = y + (k + 1) * panelH;
      for (let r = a; r < b && r < height; r++) {
        brightness[r] = 130;                     // inked row
        variance[r] = 900;
        grayRows++;
        const from = Math.floor(colLeft / colStep);
        const to = Math.ceil(colRight / colStep);
        for (let c = from; c < to && c < nCols; c++) colInk[c]++;
      }
    }
    y += ph;
    if (p < pageHeights.length - 1) { boundaries.push(y + gutter / 2); y += gutter; }
  }

  // floating site buttons outside the page: inked, but only on a few rows
  for (const r of o.sideButtons ?? []) {
    if (r >= height) continue;
    const from = Math.floor((colRight + 40) / colStep);
    const to = Math.min(nCols, from + Math.ceil(60 / colStep));
    for (let c = from; c < to; c++) colInk[c]++;
  }

  return {
    stats: { brightness, variance, saturation, colInk, colStep, grayRows, width, height },
    box: { left: colLeft, right: colRight, top, bottom: height - bottomPad,
           width: colRight - colLeft, height: height - bottomPad - top },
    boundaries, height
  };
}

/** Minimal RGB PNG encoder (zlib is built in, so no dependency). */
export function makePng(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const px = Buffer.alloc(width * height * 3, 0xff);
  paint({
    rect(x0, y0, x1, y1, [r, g, b]) {
      for (let y = Math.max(0, y0); y < Math.min(height, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
          const i = (y * width + x) * 3;
          px[i] = r; px[i + 1] = g; px[i + 2] = b;
        }
    }
  });
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    px.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
  ]);
}
