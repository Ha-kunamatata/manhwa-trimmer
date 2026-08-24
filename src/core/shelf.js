/**
 * What has been read, and finding things in a long list.
 *
 * A library of two hundred and fifty chapters is a different object from one of
 * ten. Scrolling stops working: the questions become "where was I", "what have
 * I not read", and "where is the one with that number in it". This module holds
 * the answers, kept as plain data so it can be persisted and tested without a
 * browser.
 *
 * Progress is stored per chapter rather than per series. A series-level "last
 * read" cannot say which of two hundred chapters are behind you, and that is
 * exactly what a reader coming back after a week wants to see.
 *
 * Pure — no DOM, no storage.
 */
import { naturalCompare } from "./naming.js";

/** A chapter is finished once the reader has seen all but the last leaf. */
const DONE_AT = 0.92;

export const chapterKey = (series, chapter) => series + "/" + chapter;

/**
 * Note where reading got to.
 *
 * `page` and `total` are 0-based index and count. Progress only moves forward:
 * flicking back a page to reread a panel should not un-finish a chapter, and a
 * chapter reopened at its bookmark must not report itself as barely started.
 */
export function noteRead(state, series, chapter, page, total) {
  const key = chapterKey(series, chapter);
  const prev = (state && state[key]) || null;
  const seen = Math.max(page + 1, prev ? prev.seen : 0);
  return {
    ...(state || {}),
    [key]: { seen, total: total || (prev && prev.total) || 0, at: Date.now(), page }
  };
}

export function chapterProgress(state, series, chapter) {
  const e = state && state[chapterKey(series, chapter)];
  if (!e || !e.total) return { read: false, done: false, ratio: 0, page: 0 };
  const ratio = Math.min(1, e.seen / e.total);
  return { read: true, done: ratio >= DONE_AT, ratio, page: e.page || 0, at: e.at || 0 };
}

/** How many of a series' chapters are finished. */
export function seriesProgress(state, series, chapters) {
  let done = 0, started = 0;
  for (const c of chapters) {
    const p = chapterProgress(state, series, c.name);
    if (p.done) done++;
    else if (p.read) started++;
  }
  return { done, started, total: chapters.length };
}

/**
 * The chapter to open when somebody just wants to carry on.
 *
 * The first unfinished one in reading order, not the most recently touched —
 * dipping back into chapter 3 to check something should not make chapter 3 the
 * place "continue" takes you next time.
 */
export function nextUnread(state, series, chapters) {
  for (const c of chapters) {
    const p = chapterProgress(state, series, c.name);
    if (!p.done) return c;
  }
  return null;
}

/**
 * Filter a chapter list by a typed query and a status.
 *
 * Matching is loose on digits so that "12" finds "012화" and "12-13화" — chapter
 * numbering in the wild is not tidy, and a reader typing a number means the
 * chapter with that number in it.
 */
export function filterChapters(chapters, { query = "", status = "all", state, series } = {}) {
  const q = String(query).trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return chapters.filter((c) => {
    if (q) {
      const name = String(c.name).toLowerCase();
      const nameDigits = name.replace(/\D/g, "");
      const hit = name.includes(q) ||
        (digits && (nameDigits === digits || nameDigits.includes(digits))) ||
        (c.number != null && String(c.number) === digits);
      if (!hit) return false;
    }
    if (status === "all") return true;
    const p = chapterProgress(state, series, c.name);
    if (status === "unread") return !p.read;
    if (status === "reading") return p.read && !p.done;
    if (status === "done") return p.done;
    return true;
  });
}

/** Series ordered for the shelf: what is being read now, then the rest by name. */
export function sortSeries(list, state) {
  const touched = (s) => {
    let at = 0;
    for (const c of s.chapters) {
      const p = chapterProgress(state, s.name, c.name);
      if (p.at > at) at = p.at;
    }
    return at;
  };
  return [...list].sort((a, b) => {
    const ta = touched(a), tb = touched(b);
    if (ta !== tb) return tb - ta;
    return naturalCompare(a.name, b.name);
  });
}
