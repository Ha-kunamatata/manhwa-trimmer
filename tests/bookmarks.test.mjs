import test from "node:test";
import assert from "node:assert/strict";
import {
  pinKey, isPinned, togglePin, removePin, pinsFor, groupPins, countPins
} from "../src/core/bookmarks.js";

const pin = (sourceId, page, series, chapter, at = 1) =>
  ({ sourceId, page, series, chapter, at });

test("pinning and unpinning the same page is a round trip", () => {
  const p = pin("lib:원피스/001화", 4, "원피스", "001화");
  const on = togglePin({}, p);
  assert.equal(isPinned(on, p.sourceId, 4), true);
  const off = togglePin(on, p);
  assert.equal(isPinned(off, p.sourceId, 4), false);
  assert.equal(countPins(off), 0);
});

test("the store handed in is never modified", () => {
  const before = {};
  const after = togglePin(before, pin("a", 1, "s", "c"));
  assert.deepEqual(before, {}, "the caller's store must be left alone");
  assert.equal(countPins(after), 1);
});

test("pages in different chapters do not collide", () => {
  let s = {};
  s = togglePin(s, pin("lib:원피스/001화", 3, "원피스", "001화"));
  s = togglePin(s, pin("lib:원피스/002화", 3, "원피스", "002화"));
  assert.equal(countPins(s), 2);
  assert.equal(isPinned(s, "lib:원피스/001화", 3), true);
  assert.equal(isPinned(s, "lib:원피스/002화", 3), true);
});

test("a chapter's pins come back in reading order", () => {
  let s = {};
  for (const page of [7, 2, 5]) s = togglePin(s, pin("ch", page, "원피스", "001화"));
  assert.deepEqual(pinsFor(s, "ch").map((p) => p.page), [2, 5, 7]);
});

test("removing a pin that was never there changes nothing", () => {
  const s = togglePin({}, pin("a", 1, "s", "c"));
  assert.equal(countPins(removePin(s, "a", 99)), 1);
  assert.equal(countPins(removePin(s, "a", 1)), 0);
  assert.deepEqual(removePin(undefined, "a", 1), {});
});

test("groups put the most recently touched series first", () => {
  let s = {};
  s = togglePin(s, pin("op/1", 1, "원피스", "001화", 100));
  s = togglePin(s, pin("nt/1", 1, "나루토", "001화", 500));
  const groups = groupPins(s);
  assert.deepEqual(groups.map((g) => g.series), ["나루토", "원피스"]);
});

test("inside a series, pins stay in reading order across chapters", () => {
  let s = {};
  s = togglePin(s, pin("op/2", 3, "원피스", "002화", 1));
  s = togglePin(s, pin("op/1", 9, "원피스", "001화", 2));
  s = togglePin(s, pin("op/1", 4, "원피스", "001화", 3));
  const [g] = groupPins(s);
  assert.deepEqual(g.pins.map((p) => p.chapter + ":" + p.page),
    ["001화:4", "001화:9", "002화:3"]);
});

test("an empty store yields nothing rather than throwing", () => {
  assert.deepEqual(groupPins(undefined), []);
  assert.deepEqual(pinsFor(null, "x"), []);
  assert.equal(isPinned(null, "x", 0), false);
  assert.equal(pinKey("a", 2), "a#2");
});
