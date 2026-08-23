/**
 * Turning a pile of file paths into a library.
 *
 * A folder of comics is organised by convention, not by metadata, so the only
 * thing to go on is the paths themselves. One rule covers every layout:
 *
 *   the folder holding the page IS the chapter, the folder above it IS the series
 *
 *   만화/원피스/001화/p01.png   →  원피스 · 001화     picked a whole library
 *   원피스/001화/p01.png        →  원피스 · 001화     picked one series
 *   001화/p01.png               →  001화  · 001화     picked one chapter
 *
 * No depth switch, no guessing — the same rule reads all three, which is why it
 * is worth stripping the shared leading folders first (see stripCommonRoot).
 *
 * Pure — no DOM, no I/O.
 */

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/** macOS resource forks (`._name`) look like images but are not. */
export function isImagePath(path) {
  return IMAGE_RE.test(path) && !/(^|\/)\._/.test(path);
}

/**
 * Compare names the way a person reads them: "9화" before "10화", which plain
 * string order gets backwards. Digit runs compare as numbers, the rest as text.
 */
export function naturalCompare(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [];
  const bx = String(b).match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else {
      const d = x.localeCompare(y, "ko");
      if (d) return d;
    }
  }
  return ax.length - bx.length;
}

/** The chapter number a name carries, for display. null when there isn't one. */
export function chapterNumber(name) {
  const s = String(name);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:화|권|話|장)\s*$/)
         || s.match(/(?:ch(?:apter)?|ep(?:isode)?|제)[\s._-]*(\d+(?:\.\d+)?)/i)
         || s.match(/(\d+(?:\.\d+)?)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Split off the leading folders every path shares.
 *
 * A folder picker reports paths from the picked folder down, so those shared
 * segments carry no distinction between pages — but they do carry the names.
 * Keeping them is what lets a picked chapter folder still know what it is
 * called once its own name is the only thing left.
 */
export function stripCommonRoot(paths) {
  const parts = paths.map((p) => p.split("/").filter(Boolean));
  const prefix = [];
  if (!parts.length) return { prefix, parts };
  // stop while a path segment still remains: the filename is never a folder
  while (parts.every((s) => s.length > 1 && s[0] === parts[0][0])) {
    prefix.push(parts[0][0]);
    for (const s of parts) s.shift();
  }
  return { prefix, parts };
}

/**
 * Group image entries into series → chapters → pages.
 *
 * `entries` are `{ path, ...anything }`. Whatever else they carry — a File, a
 * download URL — rides along onto the page objects untouched, so the caller
 * decides how a page is actually read.
 */
export function buildLibrary(entries) {
  const images = entries.filter((e) => isImagePath(e.path));
  if (!images.length) return [];

  const { prefix, parts } = stripCommonRoot(images.map((e) => e.path));
  const series = new Map();

  images.forEach((entry, i) => {
    const seg = parts[i];
    const dirs = prefix.concat(seg.slice(0, -1));       // every folder above the file
    const chapterName = dirs[dirs.length - 1] || "만화";
    const seriesName  = dirs[dirs.length - 2] || chapterName;

    let s = series.get(seriesName);
    if (!s) { s = { name: seriesName, chapters: new Map() }; series.set(seriesName, s); }
    let c = s.chapters.get(chapterName);
    if (!c) {
      c = { name: chapterName, number: chapterNumber(chapterName), pages: [] };
      s.chapters.set(chapterName, c);
    }
    c.pages.push({ ...entry, name: seg[seg.length - 1] });
  });

  return [...series.values()]
    .map((s) => ({
      name: s.name,
      chapters: [...s.chapters.values()]
        .map((c) => ({ ...c, pages: c.pages.sort((a, b) => naturalCompare(a.name, b.name)) }))
        .sort((a, b) => naturalCompare(a.name, b.name))
    }))
    .sort((a, b) => naturalCompare(a.name, b.name));
}
