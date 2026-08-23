/**
 * The shape of a sheet of paper being turned.
 *
 * Rotating a flat rectangle about the spine is what most page-turn effects do,
 * and it is why they look like a swinging door rather than paper. Paper bends,
 * and — this is the part that matters — it does not stretch. Its length from
 * spine to free edge is the same at every moment of the turn, so the free edge
 * cannot travel as far as a rigid flap's would. Get that wrong and the eye
 * notices immediately, even if it cannot say why.
 *
 * So the sheet is modelled as a circular arc leaving the spine at angle θ and
 * bending at constant curvature κ. Arc length is preserved exactly, by
 * construction, and the arc has a closed form — which matters because a couple
 * of hundred columns of it are evaluated every frame.
 *
 *   a(s) = θ + κs                        tangent angle at arc length s
 *   x(s) = [sin a(s) − sin θ] / κ        along the page
 *   z(s) = [cos θ − cos a(s)] / κ        towards the reader
 *
 * Pure — no DOM, no canvas.
 */

/** How far the sheet bends over its whole length, at the peak of the turn. */
const BEND = 0.95;

/**
 * Where the light is, as a tangent angle.
 *
 * Head-on, which is not an artistic choice: a sheet at rest must come out at
 * full brightness, because the moment a turn ends the curl is replaced by a
 * plain draw of the same page. Any shading left over at rest shows up as a
 * flash at the end of every single turn.
 */
const LIGHT = 0;

/**
 * Sample the turning sheet.
 *
 * `progress` runs 0 (lying flat on its own side) to 1 (lying flat on the other).
 * Returns samples from the spine outwards, each carrying where that column of
 * paper has moved to and how much light it catches.
 *
 * @param {number} progress  0..1
 * @param {number} width     the sheet's length from spine to free edge
 * @param {number} [samples] columns to sample; more is smoother and slower
 */
export function curlShape(progress, width, samples = 120) {
  const t = Math.max(0, Math.min(1, progress));
  const theta = t * Math.PI;
  // flat at both ends of the turn, most bent in the middle — paper straightens
  // out as it comes to rest
  const bend = BEND * Math.sin(theta);
  const k = bend / Math.max(1, width);

  const out = new Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    const s = (i / samples) * width;
    const a = theta + k * s;
    let x, z;
    if (Math.abs(k) < 1e-9) {
      x = s * Math.cos(theta);
      z = s * Math.sin(theta);
    } else {
      x = (Math.sin(a) - Math.sin(theta)) / k;
      z = (Math.cos(theta) - Math.cos(a)) / k;
    }
    // How squarely the surface meets the light is what makes a curl read as a
    // curve rather than a printed gradient. Taken as a magnitude because both
    // faces of a sheet catch the light — the back of a turning page is lit too,
    // and it is the edge-on middle that goes dark.
    const facing = Math.abs(Math.cos(a - LIGHT));
    out[i] = { s, x, z, shade: 0.62 + 0.38 * facing };
  }
  return out;
}

/**
 * Perspective factor for a point standing `z` above the page.
 *
 * Without this the raised half of the sheet stays the same size as the half
 * still on the table, which reads as flat no matter how well it is shaded.
 *
 * Raised paper is drawn SMALLER, not larger. Either is defensible — it depends
 * where the eye is — but the canvas is exactly the size of the book, so
 * magnifying means the lifted half is clipped by the top and bottom edges on
 * every turn. Receding costs nothing and reads as a page tilting away.
 */
export function foreshorten(z, width) {
  const focal = width * 2.6;
  return focal / (focal + Math.max(0, z));
}

/**
 * Which column of the source image is at arc length `u` along the sheet.
 *
 * The sheet is measured from the spine outwards, but an image is addressed from
 * its left edge — and which of its edges is the spine depends on the side of the
 * book the sheet is on. Getting this backwards draws the page mirrored, which is
 * surprisingly easy to miss on artwork and impossible to miss on lettering.
 *
 * @param {number} u             0 at the spine, 1 at the free edge
 * @param {number} sx            left edge of the sheet's region in the image
 * @param {number} sw            width of that region
 * @param {boolean} spineAtRight is the spine the region's right-hand edge?
 */
export function faceColumn(u, sx, sw, spineAtRight) {
  return spineAtRight ? sx + sw - u * sw : sx + u * sw;
}

/** Total length of the sampled arc — paper that stretches is a bug. */
export function arcLength(shape) {
  let sum = 0;
  for (let i = 1; i < shape.length; i++) {
    const dx = shape[i].x - shape[i - 1].x;
    const dz = shape[i].z - shape[i - 1].z;
    sum += Math.hypot(dx, dz);
  }
  return sum;
}

/**
 * Where a turn should end up when the reader lets go.
 *
 * Somebody who flicks quickly means it, even if they only moved a little, so
 * speed decides before position does.
 */
export function settleTarget(progress, velocity) {
  if (velocity > 0.9) return 1;
  if (velocity < -0.9) return 0;
  return progress >= 0.5 ? 1 : 0;
}
