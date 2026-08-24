import test from "node:test";
import assert from "node:assert/strict";
import {
  noteRead, chapterProgress, seriesProgress, nextUnread, filterChapters, sortSeries
} from "../src/core/shelf.js";

const chapters = (...names) => names.map((n) => ({ name: n, number: parseInt(n, 10) || null }));

test("reading a chapter to the end marks it finished", () => {
  let s = {};
  s = noteRead(s, "원피스", "001화", 19, 20);
  const p = chapterProgress(s, "원피스", "001화");
  assert.equal(p.read, true);
  assert.equal(p.done, true);
});

test("stopping halfway is in progress, not finished", () => {
  const s = noteRead({}, "원피스", "001화", 5, 20);
  const p = chapterProgress(s, "원피스", "001화");
  assert.equal(p.read, true);
  assert.equal(p.done, false);
  assert.ok(p.ratio > 0.2 && p.ratio < 0.4);
});

test("flicking back does not un-finish a chapter", () => {
  // rereading a panel must not undo having read the thing
  let s = noteRead({}, "원피스", "001화", 19, 20);
  s = noteRead(s, "원피스", "001화", 2, 20);
  assert.equal(chapterProgress(s, "원피스", "001화").done, true);
  assert.equal(chapterProgress(s, "원피스", "001화").page, 2, "but it remembers where you are");
});

test("an untouched chapter reports nothing rather than throwing", () => {
  const p = chapterProgress(undefined, "원피스", "001화");
  assert.deepEqual(p, { read: false, done: false, ratio: 0, page: 0 });
});

test("a series counts what is finished and what is under way", () => {
  let s = {};
  s = noteRead(s, "원피스", "001화", 19, 20);
  s = noteRead(s, "원피스", "002화", 3, 20);
  const p = seriesProgress(s, "원피스", chapters("001화", "002화", "003화"));
  assert.deepEqual(p, { done: 1, started: 1, total: 3 });
});

test("continue opens the first unfinished chapter, not the last touched", () => {
  const list = chapters("001화", "002화", "003화");
  let s = {};
  s = noteRead(s, "원피스", "001화", 19, 20);
  s = noteRead(s, "원피스", "002화", 19, 20);
  s = noteRead(s, "원피스", "001화", 4, 20);     // dipped back into chapter 1
  assert.equal(nextUnread(s, "원피스", list).name, "003화");
});

test("searching by number finds however the chapter was named", () => {
  const list = chapters("012화", "12-13화", "120화", "3화");
  const found = filterChapters(list, { query: "12" }).map((c) => c.name);
  assert.ok(found.includes("012화"), "leading zeros must not hide it");
  assert.ok(found.includes("12-13화"), "a combined chapter still contains 12");
  assert.ok(!found.includes("3화"));
});

test("filtering by status splits unread, reading and finished", () => {
  const list = chapters("001화", "002화", "003화");
  let s = {};
  s = noteRead(s, "원피스", "001화", 19, 20);
  s = noteRead(s, "원피스", "002화", 3, 20);
  const pick = (status) =>
    filterChapters(list, { status, state: s, series: "원피스" }).map((c) => c.name);
  assert.deepEqual(pick("done"), ["001화"]);
  assert.deepEqual(pick("reading"), ["002화"]);
  assert.deepEqual(pick("unread"), ["003화"]);
  assert.equal(pick("all").length, 3);
});

test("the shelf puts what is being read first", () => {
  const shelf = [
    { name: "나루토", chapters: chapters("001화") },
    { name: "원피스", chapters: chapters("001화") }
  ];
  const s = noteRead({}, "원피스", "001화", 1, 20);
  assert.deepEqual(sortSeries(shelf, s).map((x) => x.name), ["원피스", "나루토"]);
  // and falls back to natural order when nothing has been read
  assert.deepEqual(sortSeries(shelf, {}).map((x) => x.name), ["나루토", "원피스"]);
});
