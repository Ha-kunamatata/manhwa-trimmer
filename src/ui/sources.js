/**
 * Page sources.
 *
 * The reader draws pages without knowing where they came from — a strip that
 * was just sliced, a folder of images on disk, or a private repository over the
 * network. Every source answers the same questions:
 *
 *   id            stable key; the reading position is bookmarked against it
 *   title         shown in the reader bar
 *   count         pages in THIS chapter
 *   getPage(i)    → Promise<{ img, sx, sy, sw, sh }>, ready for drawImage
 *   release()     drop decoded pixels; called when the reader lets go
 *   nextChapter() → Promise<PageSource|null>   optional, for reading straight on
 *   prevChapter() → Promise<PageSource|null>   optional
 *
 * Returning a source rectangle rather than a bare image is what lets a sliced
 * strip and a standalone file look identical here: the strip hands back its one
 * big canvas with the page's rect, a file hands back a bitmap with its own.
 */

/** Pages kept decoded on each side of the one being read. */
const WINDOW = 3;

/** The freshly sliced strip, drawn straight out of the analysis canvas. */
export function stripSource({ id, title, canvas, box, pages }) {
  return {
    id: id || "strip:" + title,
    title,
    count: pages.length,
    async getPage(i) {
      const p = pages[i];
      if (!p) return null;
      return { img: canvas, sx: box.left, sy: p.start, sw: box.width, sh: p.height };
    },
    release() {}
  };
}

/**
 * A chapter that is a list of separate images.
 *
 * `decode(item, i)` returns a Promise of anything drawable with a `width` and
 * `height`. Hundreds of pages cannot all be held decoded at once — a phone runs
 * out of memory long before that — so only a window around the current page is
 * kept, and bitmaps outside it are closed.
 */
export function imageListSource({ id, title, items, decode, nextChapter, prevChapter }) {
  const cache = new Map();          // index -> Promise<{ img, sx, sy, sw, sh }>

  const drop = (entry) => Promise.resolve(entry).then(
    (v) => { if (v && v.img && v.img.close) v.img.close(); },
    () => {}
  );

  function want(i) {
    if (i < 0 || i >= items.length) return null;
    let entry = cache.get(i);
    if (!entry) {
      entry = decode(items[i], i).then(
        (img) => ({ img, sx: 0, sy: 0, sw: img.width, sh: img.height }),
        (err) => {
          // a rejected promise left in the cache would fail this page forever,
          // turning one hiccup into a permanently unreadable page
          if (cache.get(i) === entry) cache.delete(i);
          throw err;
        }
      );
      cache.set(i, entry);
    }
    return entry;
  }

  return {
    id, title,
    count: items.length,
    items,
    async getPage(i) {
      const page = want(i);
      if (!page) return null;
      // warm what the reader is about to need, then let the rest go
      for (let d = 1; d <= WINDOW; d++) { want(i + d); want(i - d); }
      for (const [k, entry] of cache) {
        if (Math.abs(k - i) > WINDOW) { cache.delete(k); drop(entry); }
      }
      return page;
    },
    release() {
      for (const entry of cache.values()) drop(entry);
      cache.clear();
    },
    nextChapter, prevChapter
  };
}

/**
 * A chapter whose pages were cut out of long captures.
 *
 * `pages` are rectangles that each name the file they came from, so many pages
 * share one decoded image. That is the opposite of the case above and needs the
 * opposite caching: a capture is enormous — a 900 x 20000 strip is 72MB once
 * decoded — so only a couple of them may be held, and they are held by FILE
 * rather than by page. Reading forwards touches one file for dozens of pages in
 * a row, which is what makes so small a cache workable.
 */
export function slicedSource({ id, title, pages, load, nextChapter, prevChapter }) {
  const KEEP = 2;
  const open = new Map();            // fileIndex -> Promise<drawable>
  const used = [];                   // fileIndex, most recently wanted last

  function file(i) {
    let entry = open.get(i);
    if (!entry) {
      entry = load(i).catch((err) => { if (open.get(i) === entry) open.delete(i); throw err; });
      open.set(i, entry);
    }
    const at = used.indexOf(i);
    if (at >= 0) used.splice(at, 1);
    used.push(i);
    while (used.length > KEEP) {
      const gone = used.shift();
      const dead = open.get(gone);
      open.delete(gone);
      Promise.resolve(dead).then((v) => { if (v && v.close) v.close(); }, () => {});
    }
    return entry;
  }

  return {
    id, title,
    count: pages.length,
    async getPage(i) {
      const p = pages[i];
      if (!p) return null;
      const img = await file(p.file);
      return { img, sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh };
    },
    release() {
      for (const entry of open.values())
        Promise.resolve(entry).then((v) => { if (v && v.close) v.close(); }, () => {});
      open.clear();
      used.length = 0;
    },
    nextChapter, prevChapter
  };
}

/** Decode a Blob/File into something drawable, with a path for older Safari. */
export function decodeBlob(blob) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob).catch(() => viaImgElement(blob));
  }
  return viaImgElement(blob);
}

function viaImgElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // an <img> has no close(); give it one so the window eviction is uniform
      img.close = () => URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}
