import test from "node:test";
import assert from "node:assert/strict";
import { normalise, withRepo, withoutRepo, parseRepo, repoLabel } from "../src/ui/github.js";

// These are the pure half of the GitHub source: what a saved connection means.
// They are tested here rather than in e2e because the migration below fails
// silently — an install that stops finding its comics after an update looks
// like an empty shelf, not like an error.

test("a connection saved before multi-repo still reads", () => {
  const old = { token: "t", owner: "Ha-kunamatata", repo: "manhwa-library", branch: "", path: "" };
  const c = normalise(old);
  assert.equal(c.token, "t");
  assert.deepEqual(c.repos.map(repoLabel), ["Ha-kunamatata/manhwa-library"]);
});

test("a sub-folder survives the migration", () => {
  const c = normalise({ token: "t", owner: "me", repo: "comics", path: "만화" });
  assert.equal(repoLabel(c.repos[0]), "me/comics/만화");
});

test("nothing readable is no connection at all", () => {
  assert.equal(normalise(null), null);
  assert.equal(normalise({ token: "t" }), null, "a token alone points nowhere");
  assert.equal(normalise({ repos: [{ owner: "me", repo: "c" }] }), null, "and so does a repo with no token");
  assert.equal(normalise({ token: "t", repos: [{ owner: "me" }] }), null);
});

test("adding a repository keeps the ones already there", () => {
  let c = withRepo(null, { owner: "me", repo: "one" }, "t");
  c = withRepo(c, { owner: "me", repo: "two" });
  assert.deepEqual(c.repos.map((r) => r.repo), ["one", "two"]);
  assert.equal(c.token, "t");
});

test("the same repository cannot be added twice", () => {
  let c = withRepo(null, { owner: "me", repo: "one" }, "t");
  c = withRepo(c, { owner: "ME", repo: "One" });   // GitHub names are case-insensitive
  assert.equal(c.repos.length, 1);
});

test("removing the last repository is a disconnect, not an empty connection", () => {
  const c = withRepo(null, { owner: "me", repo: "one" }, "t");
  assert.equal(withoutRepo(c, { owner: "me", repo: "one" }), null);
});

test("removing one of several leaves the rest and the token", () => {
  let c = withRepo(null, { owner: "me", repo: "one" }, "t");
  c = withRepo(c, { owner: "me", repo: "two" });
  const left = withoutRepo(c, { owner: "me", repo: "one" });
  assert.deepEqual(left.repos.map((r) => r.repo), ["two"]);
  assert.equal(left.token, "t");
});

test("a repository can be named however it was pasted", () => {
  assert.deepEqual(parseRepo("me/comics"), { owner: "me", repo: "comics" });
  assert.deepEqual(parseRepo("https://github.com/me/comics"), { owner: "me", repo: "comics" });
  assert.deepEqual(parseRepo("git@github.com:me/comics.git"), { owner: "me", repo: "comics" });
  assert.equal(parseRepo("comics"), null);
});
