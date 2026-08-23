/**
 * Pure image analysis: turn a long capture into per-row and per-column
 * statistics. No DOM beyond the 2D context it is handed.
 */

/**
 * Scan the strip row by row.
 *
 * Comic paper is grayscale and light; site chrome and ad banners are neither.
 * Only rows that look like printed paper vote on where the page column sits,
 * which is what keeps a full-width dark header from stretching the column to
 * the whole image.
 *
 * @param {CanvasRenderingContext2D} ctx  context holding the full image
 * @param {number} w image width
 * @param {number} h image height
 * @param {{onProgress?:(f:number)=>void, chunkRows?:number, yieldFn?:()=>Promise<void>}} [opts]
 * @returns {Promise<StripStats>}
 */
export async function analyseStrip(ctx, w, h, opts = {}) {
  const { onProgress, chunkRows = 800, yieldFn } = opts;
  const colStep = Math.max(1, Math.floor(w / 400));
  const nCols = Math.ceil(w / colStep);

  const brightness = new Float32Array(h);
  const variance = new Float32Array(h);
  const saturation = new Float32Array(h);
  const colInk = new Int32Array(nCols);
  let grayRows = 0;

  for (let y0 = 0; y0 < h; y0 += chunkRows) {
    const rows = Math.min(chunkRows, h - y0);
    const data = ctx.getImageData(0, y0, w, rows).data;

    for (let ry = 0; ry < rows; ry++) {
      let sum = 0, sumSq = 0, count = 0, satSum = 0;
      const off = ry * w * 4;

      for (let x = 0; x < w; x += colStep) {
        const i = off + x * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        sum += lum;
        sumSq += lum * lum;
        count++;
        satSum += Math.max(r, g, b) - Math.min(r, g, b);
      }

      const mean = count ? sum / count : 0;
      const sat = count ? satSum / count : 0;
      brightness[y0 + ry] = mean;
      variance[y0 + ry] = count ? Math.max(0, sumSq / count - mean * mean) : 0;
      saturation[y0 + ry] = sat;

      if (count && sat < 18 && mean > 140) {
        grayRows++;
        let xi = 0;
        for (let x = 0; x < w; x += colStep, xi++) {
          const i = off + x * 4;
          if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 232) colInk[xi]++;
        }
      }
    }

    if (onProgress) onProgress(Math.min(1, (y0 + rows) / h));
    if (yieldFn) await yieldFn();
  }

  return { brightness, variance, saturation, colInk, colStep, grayRows, width: w, height: h };
}

/**
 * @typedef {Object} StripStats
 * @property {Float32Array} brightness mean luminance per row
 * @property {Float32Array} variance   luminance variance per row
 * @property {Float32Array} saturation mean chroma per row
 * @property {Int32Array}   colInk     inked-row count per sampled column
 * @property {number}       colStep    column sampling stride
 * @property {number}       grayRows   number of rows that looked like paper
 * @property {number}       width
 * @property {number}       height
 */
