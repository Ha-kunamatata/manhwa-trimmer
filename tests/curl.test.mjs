import test from "node:test";
import assert from "node:assert/strict";
import { curlShape, arcLength, foreshorten, settleTarget, faceColumn } from "../src/core/curl.js";

const W = 400;

test("paper does not stretch at any point in the turn", () => {
  // the whole reason for the arc model: length from spine to free edge is
  // constant, so the free edge cannot reach where a rigid flap's would
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const len = arcLength(curlShape(t, W, 400));
    assert.ok(Math.abs(len - W) / W < 0.002,
      `progress ${t.toFixed(2)} gave length ${len.toFixed(1)}, wanted ${W}`);
  }
});

test("the sheet lies flat at both ends of the turn", () => {
  const start = curlShape(0, W);
  const end = curlShape(1, W);
  for (const p of start) assert.ok(Math.abs(p.z) < 0.01, "start should be flat");
  for (const p of end) assert.ok(Math.abs(p.z) < 0.01, "end should be flat");
  assert.ok(Math.abs(start[start.length - 1].x - W) < 0.01, "starts on its own side");
  assert.ok(Math.abs(end[end.length - 1].x + W) < 0.01, "ends on the other side");
});

test("the sheet lifts off the page in the middle of the turn", () => {
  const mid = curlShape(0.5, W);
  const highest = Math.max(...mid.map((p) => p.z));
  assert.ok(highest > W * 0.5, "mid-turn should stand well off the page, got " + highest);
});

test("the free edge falls short of a rigid flap's reach", () => {
  // a hinged board of length W would put its tip on the circle of radius W;
  // curved paper keeps its tip inside that circle
  const mid = curlShape(0.5, W);
  const tip = mid[mid.length - 1];
  assert.ok(Math.hypot(tip.x, tip.z) < W * 0.98,
    "curved paper should not reach as far as a rigid flap");
});

test("a sheet at rest is not shaded at all", () => {
  // the instant a turn ends, the curl is replaced by a plain draw of the same
  // page. Leftover shading at rest would flash at the end of every turn.
  for (const t of [0, 1]) {
    for (const p of curlShape(t, W)) {
      assert.ok(Math.abs(p.shade - 1) < 1e-9,
        `progress ${t} shaded ${p.shade}, should be untouched`);
    }
  }
});

test("shading follows the curve rather than the clock", () => {
  const mid = curlShape(0.45, W);
  const shades = mid.map((p) => p.shade);
  assert.ok(Math.max(...shades) - Math.min(...shades) > 0.1,
    "a curved sheet should not be evenly lit");
  for (const s of shades) assert.ok(s > 0 && s <= 1, "shade out of range: " + s);
});

test("raised paper recedes, and never grows past its own frame", () => {
  assert.ok(Math.abs(foreshorten(0, W) - 1) < 1e-9, "paper at rest is drawn true size");
  assert.ok(foreshorten(W * 0.5, W) < 1, "lifted paper tilts away from the reader");
  // the canvas is exactly the size of the book: anything over 1 gets clipped
  for (let z = 0; z <= W * 4; z += W / 8) {
    assert.ok(foreshorten(z, W) <= 1, "scale must never exceed 1 at z=" + z);
  }
  assert.ok(Number.isFinite(foreshorten(W * 100, W)), "never divides through zero");
});

test("a flick settles the way it was thrown, not the way it sits", () => {
  assert.equal(settleTarget(0.1, 2), 1, "a fast flick carries a barely-moved page over");
  assert.equal(settleTarget(0.9, -2), 0, "and a fast flick back brings it home");
  assert.equal(settleTarget(0.6, 0), 1);
  assert.equal(settleTarget(0.4, 0), 0);
});

test("a face is read from the spine outwards, whichever edge that is", () => {
  // sheet on the left of the spine: its own right edge is the hinge, so the
  // column at the spine is the LAST column of the image region
  assert.equal(faceColumn(0, 100, 50, true), 150);
  assert.equal(faceColumn(1, 100, 50, true), 100);
  // sheet on the right of the spine: the hinge is its left edge
  assert.equal(faceColumn(0, 100, 50, false), 100);
  assert.equal(faceColumn(1, 100, 50, false), 150);
  // and halfway is halfway either way round
  assert.equal(faceColumn(0.5, 100, 50, true), 125);
  assert.equal(faceColumn(0.5, 100, 50, false), 125);
});
