import test from "node:test";
import assert from "node:assert/strict";
import {
  naturalCompare, chapterNumber, isImagePath, stripCommonRoot, buildLibrary
} from "../src/core/naming.js";

const paths = (...p) => p.map((path) => ({ path }));
const names = (list) => list.map((x) => x.name);

test("natural order puts 9화 before 10화", () => {
  const sorted = ["10화", "9화", "1화", "100화", "2화"].sort(naturalCompare);
  assert.deepEqual(sorted, ["1화", "2화", "9화", "10화", "100화"]);
});

test("natural order handles zero padding and mixed text", () => {
  const sorted = ["p10.png", "p2.png", "p01.png"].sort(naturalCompare);
  assert.deepEqual(sorted, ["p01.png", "p2.png", "p10.png"]);
});

test("chapter numbers are read from the shapes people actually type", () => {
  assert.equal(chapterNumber("001화"), 1);
  assert.equal(chapterNumber("제 12 화"), 12);
  assert.equal(chapterNumber("ch03"), 3);
  assert.equal(chapterNumber("Chapter 5"), 5);
  assert.equal(chapterNumber("42"), 42);
  assert.equal(chapterNumber("외전"), null);
});

test("resource forks are not images", () => {
  assert.equal(isImagePath("a/p01.png"), true);
  assert.equal(isImagePath("a/._p01.png"), false);
  assert.equal(isImagePath("a/notes.txt"), false);
});

test("the shared prefix is split off but not thrown away", () => {
  const { prefix, parts } = stripCommonRoot([
    "만화/원피스/001화/p01.png",
    "만화/원피스/002화/p01.png"
  ]);
  assert.deepEqual(prefix, ["만화", "원피스"]);
  assert.deepEqual(parts, [["001화", "p01.png"], ["002화", "p01.png"]]);
});

test("a whole library reads as series and chapters", () => {
  const lib = buildLibrary(paths(
    "만화/원피스/002화/p02.png",
    "만화/원피스/001화/p02.png",
    "만화/원피스/001화/p01.png",
    "만화/나루토/001화/p01.png"
  ));
  assert.deepEqual(names(lib), ["나루토", "원피스"]);
  const onePiece = lib.find((s) => s.name === "원피스");
  assert.deepEqual(names(onePiece.chapters), ["001화", "002화"]);
  assert.deepEqual(names(onePiece.chapters[0].pages), ["p01.png", "p02.png"]);
});

test("picking one series folder still names the series", () => {
  const lib = buildLibrary(paths("원피스/001화/p01.png", "원피스/002화/p01.png"));
  assert.deepEqual(names(lib), ["원피스"]);
  assert.deepEqual(names(lib[0].chapters), ["001화", "002화"]);
});

test("picking a single chapter folder names it after itself", () => {
  const lib = buildLibrary(paths("001화/p02.png", "001화/p01.png"));
  assert.deepEqual(names(lib), ["001화"]);
  assert.deepEqual(names(lib[0].chapters), ["001화"]);
  assert.deepEqual(names(lib[0].chapters[0].pages), ["p01.png", "p02.png"]);
});

test("a single series folder collapses to one chapter, not one per page", () => {
  // every path shares 만화/원피스/001화, so stripping leaves only filenames —
  // the names have to survive that, or the chapter loses its identity
  const lib = buildLibrary(paths("만화/원피스/001화/p01.png", "만화/원피스/001화/p02.png"));
  assert.deepEqual(names(lib), ["원피스"]);
  assert.deepEqual(names(lib[0].chapters), ["001화"]);
  assert.equal(lib[0].chapters[0].pages.length, 2);
});

test("extra data on an entry rides along to the page", () => {
  const lib = buildLibrary([{ path: "001화/p01.png", url: "https://x/p01.png" }]);
  assert.equal(lib[0].chapters[0].pages[0].url, "https://x/p01.png");
});

test("non-images are dropped and an all-junk folder yields nothing", () => {
  assert.deepEqual(buildLibrary(paths("a/readme.txt", "a/.DS_Store")), []);
});
