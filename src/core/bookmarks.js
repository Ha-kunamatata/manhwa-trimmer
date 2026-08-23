/**
 * Pinned pages.
 *
 * A pin is a page somebody wanted to come back to — a scene worth rereading, or
 * simply where they stopped. Kept as one flat map rather than nested under
 * series and chapter, because every operation the reader performs is on a single
 * page ("is this one pinned?", "unpin it"), and a flat map answers that without
 * walking anything. Grouping is the rarer job, so grouping is what pays the cost.
 *
 * Every function here takes a store and returns a new one; nothing is mutated,
 * so a caller can persist the result without wondering what else changed.
 *
 * Pure — no DOM, no storage.
 */

export const pinKey = (sourceId, page) => sourceId + "#" + page;

/**
 * @typedef {object} Pin
 * @property {string} sourceId  the chapter the page belongs to
 * @property {number} page      0-based index within that chapter
 * @property {string} series
 * @property {string} chapter
 * @property {number} at        when it was pinned
 */

export function isPinned(store, sourceId, page) {
  return !!(store && store[pinKey(sourceId, page)]);
}

/** Add a pin, or take it away if that page already has one. */
export function togglePin(store, pin) {
  const key = pinKey(pin.sourceId, pin.page);
  const next = { ...(store || {}) };
  if (next[key]) delete next[key];
  else next[key] = { ...pin };
  return next;
}

export function removePin(store, sourceId, page) {
  const key = pinKey(sourceId, page);
  if (!store || !store[key]) return store || {};
  const next = { ...store };
  delete next[key];
  return next;
}

/** Pins in one chapter, in reading order. */
export function pinsFor(store, sourceId) {
  return Object.values(store || {})
    .filter((p) => p.sourceId === sourceId)
    .sort((a, b) => a.page - b.page);
}

/**
 * Every pin, grouped by series, newest group first.
 *
 * Within a series the pins stay in reading order, because that is how somebody
 * scanning a list of scenes expects to find them — but the series themselves are
 * ordered by what was touched most recently, which is what people are looking
 * for when they open the list at all.
 */
export function groupPins(store) {
  const groups = new Map();
  for (const p of Object.values(store || {})) {
    let g = groups.get(p.series);
    if (!g) { g = { series: p.series, pins: [], at: 0 }; groups.set(p.series, g); }
    g.pins.push(p);
    if (p.at > g.at) g.at = p.at;
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      pins: g.pins.sort((a, b) =>
        a.chapter === b.chapter ? a.page - b.page : String(a.chapter).localeCompare(String(b.chapter), "ko"))
    }))
    .sort((a, b) => b.at - a.at);
}

export function countPins(store) {
  return Object.keys(store || {}).length;
}
