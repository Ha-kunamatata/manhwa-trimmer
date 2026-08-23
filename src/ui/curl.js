/**
 * Drawing the turning sheet.
 *
 * The geometry lives in ../core/curl.js; this puts it on a canvas. The sheet is
 * drawn as a run of thin vertical slices, each taken from the page image and
 * placed where that column of paper has moved to. Slices are the trick that
 * makes a curve affordable: the browser draws axis-aligned rectangles quickly
 * and nothing else, so a curved surface becomes a couple of hundred of them,
 * each individually straight.
 *
 * Everything else here exists because of what slicing costs:
 *
 *   Slices overlap by a pixel, or rounding leaves hairline gaps and the page
 *   looks like a comb.
 *
 *   Because they overlap, shading cannot be painted per slice — a translucent
 *   fill drawn twice over the seam comes out darker, and every seam shows. The
 *   light goes on afterwards as one gradient, clipped to the sheet's outline.
 *
 *   Near edge-on the whole page squeezes into a narrow band, so the slice count
 *   is thinned to match the screen width it actually covers.
 */
import { curlShape, foreshorten, faceColumn } from "../core/curl.js";

/**
 * Draw one frame of a turning page.
 *
 * `front` and `back` each name an image AND the rectangle within it the sheet
 * is cut from, because in a spread the sheet is one half of a wider render.
 * Passing the rectangle explicitly is what keeps the faces from being mirrored
 * relative to each other.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 * @param {number} o.progress   0 = still on its own side, 1 = fully turned
 * @param {boolean} o.leftward  true when the free edge starts left of the spine
 * @param {number} o.spineX     the hinge, in canvas pixels
 * @param {number} o.width      spine to free edge, in canvas pixels
 * @param {number} o.height     sheet height, in canvas pixels
 * @param {number} o.top        top of the sheet, in canvas pixels
 * @param {{img:*, sx:number, sw:number, sh:number}} o.front  showing until halfway
 * @param {{img:*, sx:number, sw:number, sh:number}} o.back   showing after halfway
 */
export function drawCurl(ctx, o) {
  const { progress, leftward, spineX, width, height, top } = o;
  const dir = leftward ? -1 : 1;
  const flipped = progress > 0.5;
  const face = flipped ? o.back : o.front;
  if (!face || !face.img || width <= 0) return;

  // the front sits with its spine on whichever side the sheet started; once it
  // has turned over, the face on show is the one that lands on the far side
  const spineAtRight = flipped ? !leftward : leftward;

  const cols = Math.max(48, Math.min(220, Math.round(width / 3)));
  const shape = curlShape(progress, width, cols);
  const midY = top + height / 2;

  // project every sample once: the slices, the outline and the light all need it
  const pts = shape.map((p) => {
    const m = foreshorten(p.z, width);
    const h = height * m;
    return {
      u: p.s / width, shade: p.shade,
      x: spineX + dir * p.x * m,
      yTop: midY - h / 2,
      h
    };
  });

  const span = Math.abs(pts[pts.length - 1].x - pts[0].x);
  const stride = Math.max(1, Math.ceil(cols / Math.max(8, span / 2)));

  ctx.save();
  castShadow(ctx, o, pts, dir);

  for (let i = 0; i < pts.length - 1; i += stride) {
    const a = pts[i], b = pts[Math.min(i + stride, pts.length - 1)];
    if (a === b) break;
    const left = Math.min(a.x, b.x);
    const w = Math.max(0.6, Math.abs(b.x - a.x)) + 1;   // the pixel of overlap
    if (!Number.isFinite(left)) continue;

    const ua = faceColumn(a.u, face.sx, face.sw, spineAtRight);
    const ub = faceColumn(b.u, face.sx, face.sw, spineAtRight);
    const sLeft = Math.min(ua, ub);
    const sw = Math.max(0.5, Math.abs(ub - ua));
    const h = (a.h + b.h) / 2;

    ctx.drawImage(face.img, sLeft, 0, sw, face.sh, left, (a.yTop + b.yTop) / 2, w, h);
  }

  shadeSheet(ctx, pts, stride);
  ctx.restore();
}

/** Lay the light over the sheet in one pass, clipped to its outline. */
function shadeSheet(ctx, pts, stride) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.yTop < minY) minY = p.yTop;
    if (p.yTop + p.h > maxY) maxY = p.yTop + p.h;
  }
  if (!(maxX - minX > 0.5)) return;

  ctx.beginPath();
  for (let i = 0; i < pts.length; i += stride) ctx.lineTo(pts[i].x, pts[i].yTop);
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].yTop);
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].yTop + pts[pts.length - 1].h);
  for (let i = pts.length - 1; i >= 0; i -= stride) ctx.lineTo(pts[i].x, pts[i].yTop + pts[i].h);
  ctx.closePath();
  ctx.clip();

  const g = ctx.createLinearGradient(minX, 0, maxX, 0);
  const seen = new Set();
  for (let i = 0; i < pts.length; i += stride) {
    const at = Math.max(0, Math.min(1, (pts[i].x - minX) / (maxX - minX)));
    // a curled sheet can fold back on itself, so the same x can arrive twice
    const key = at.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    g.addColorStop(at, "rgba(0,0,0," + (1 - pts[i].shade).toFixed(3) + ")");
  }
  ctx.fillStyle = g;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
}

/**
 * Darken the page under the sheet.
 *
 * The shadow tracks the sheet's free edge and softens as the sheet rises away —
 * paper held high casts a faint, distant shadow, paper about to land casts a
 * hard one right underneath itself.
 */
function castShadow(ctx, o, pts, dir) {
  const { spineX, height, top, progress } = o;
  const tip = pts[pts.length - 1];
  const strength = 0.28 * Math.sin(Math.PI * progress);
  if (strength <= 0.005) return;

  const reach = spineX + (tip.x - spineX) * 0.9;
  const from = Math.min(spineX, reach);
  const to = Math.max(spineX, reach);
  if (to - from < 1) return;

  const g = ctx.createLinearGradient(from, 0, to, 0);
  const nearSpine = dir < 0 ? 1 : 0;      // the shadow is deepest at the hinge
  g.addColorStop(nearSpine, "rgba(0,0,0," + strength.toFixed(3) + ")");
  g.addColorStop(1 - nearSpine, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(from, top, to - from, height);
}
