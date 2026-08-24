/**
 * The library — picking comics and handing chapters to the reader.
 *
 * Everything a comic can be read from is flattened to one shape before it gets
 * here: a list of `{ path, load() }`, where `load` resolves to a Blob. A folder
 * on disk and a private repository differ only in how that list is produced, so
 * the grouping, the browsing and the reading are written once.
 *
 * Folder access is three-tiered because the platforms differ sharply:
 *
 *   showDirectoryPicker   Chrome/Edge on the desktop. The only one that can be
 *                         re-opened later without asking again, so a picked
 *                         folder survives closing the app.
 *   webkitdirectory       most other desktop browsers. One shot, no memory.
 *   multiple files        iOS Safari, which has neither of the above.
 */
import { buildLibrary, chapterNumber, naturalCompare } from "../core/naming.js";
import {
  noteRead, chapterProgress, seriesProgress, nextUnread, filterChapters, sortSeries
} from "../core/shelf.js";
import { imageListSource, slicedSource, decodeBlob } from "./sources.js";
import { sliceChapter, pagesFrom, probeIsStrip } from "./slicer.js";
import { createGithubProvider, githubPanel } from "./github.js";

export function createLibrary(els, openReader, toast) {
  let series = [];             // [{ name, chapters:[{ name, pages }] }]
  let sourceLabel = "";
  let current = null;          // the series being browsed
  let stripMode = false;       // the folder holds uncut captures, not pages
  const plans = new Map();     // chapter key -> page rectangles, measured once

  // ---------- progress ----------
  const PROGRESS_KEY = "manhwa-progress";
  function allProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function noteProgress(seriesName, chapterName, page, total) {
    const all = allProgress();
    all[seriesName] = { chapter: chapterName, page, total, at: Date.now() };
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch (e) {}
  }

  // ---------- intake ----------
  async function adopt(entries, label) {
    if (!entries.length) { toast("이미지를 찾지 못했어요."); return; }
    series = buildLibrary(entries);
    if (!series.length) { toast("이미지를 찾지 못했어요."); return; }
    sourceLabel = label;
    current = null;
    plans.clear();

    // One decode says which kind of folder this is, and that changes what the
    // folders mean — so it has to be settled before anything is listed.
    busy("확인하는 중…");
    const first = series[0].chapters[0] && series[0].chapters[0].pages[0];
    stripMode = first ? await probeIsStrip(first) : false;
    if (stripMode) series = regroupAsStrips(series);
    render();
    announce();
  }

  /**
   * Say what was found.
   *
   * Silence after a successful load is what let somebody connect to the wrong
   * repository and sit there wondering. "1개 시리즈 · 4화" next to a repository
   * named after the app answers the question before it gets asked.
   */
  function announce() {
    const chapters = series.reduce((n, s) => n + s.chapters.length, 0);
    toast(series.length === 1
      ? series[0].name + " · " + chapters + "화를 찾았어요."
      : series.length + "개 시리즈 · " + chapters + "화를 찾았어요.");
  }

  /**
   * Re-read the folders on the understanding that the images are captures.
   *
   * A page belongs to a chapter, but a capture IS a chapter — so a folder
   * holding several captures is not a chapter, it is a series, and every level
   * shifts up by one. A folder holding a single capture is left alone: there the
   * folder name is the chapter's name and says more than the file's does.
   */
  function regroupAsStrips(list) {
    const out = [];
    for (const s of list) {
      const keep = [];
      for (const c of s.chapters) {
        if (c.pages.length <= 1) { keep.push(c); continue; }
        out.push({
          name: c.name,
          chapters: c.pages
            .map((page) => {
              const name = page.name.replace(/\.[^.]+$/, "");
              return { name, number: chapterNumber(name), pages: [page] };
            })
            .sort((a, b) => naturalCompare(a.name, b.name))
        });
      }
      if (keep.length) out.push({ name: s.name, chapters: keep });
    }
    return out.sort((a, b) => naturalCompare(a.name, b.name));
  }

  /** Walk a File System Access directory handle into flat entries. */
  async function walkDir(handle, prefix) {
    const out = [];
    const stack = [[handle, prefix || handle.name]];
    while (stack.length) {
      const [dir, base] = stack.pop();
      for await (const [name, entry] of dir.entries()) {
        if (name.startsWith(".")) continue;
        const path = base ? base + "/" + name : name;
        if (entry.kind === "directory") stack.push([entry, path]);
        else out.push({ path, load: () => entry.getFile() });
      }
    }
    return out;
  }

  const hasFSA = typeof window.showDirectoryPicker === "function";

  async function pickFolder() {
    if (hasFSA) {
      let handle;
      try { handle = await window.showDirectoryPicker({ id: "manhwa", mode: "read" }); }
      catch (e) { return; }                       // the user backed out
      await rememberHandle(handle);
      busy("폴더를 읽는 중…");
      await adopt(await walkDir(handle), handle.name);
      return;
    }
    els.folderInput.click();                      // webkitdirectory fallback
  }

  els.folderInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    const root = (files[0].webkitRelativePath || "").split("/")[0] || "만화";
    await adopt(files.map((f) => ({
      path: f.webkitRelativePath || f.name, load: async () => f
    })), root);
  });

  els.filesInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    await adopt(files.map((f) => ({ path: f.name, load: async () => f })), "선택한 파일");
  });

  els.pickFolderBtn.addEventListener("click", pickFolder);
  els.pickFilesBtn.addEventListener("click", () => els.filesInput.click());

  // ---------- remembering the last folder (Chrome/Edge only) ----------
  const DB = "manhwa-trimmer", STORE = "handles";
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function rememberHandle(handle) {
    if (!hasFSA) return;
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(handle, "lastFolder");
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      showResume(handle.name);
    } catch (e) {}
  }
  async function storedHandle() {
    if (!hasFSA) return null;
    try {
      const db = await idb();
      return await new Promise((res) => {
        const rq = db.transaction(STORE, "readonly").objectStore(STORE).get("lastFolder");
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      });
    } catch (e) { return null; }
  }
  function showResume(name) {
    els.resumeBtn.hidden = false;
    els.resumeBtn.textContent = "‹" + name + "› 다시 열기";
  }
  els.resumeBtn.addEventListener("click", async () => {
    const handle = await storedHandle();
    if (!handle) { els.resumeBtn.hidden = true; return; }
    // permission does not survive a reload; ask for it back
    let ok = await handle.queryPermission({ mode: "read" });
    if (ok !== "granted") ok = await handle.requestPermission({ mode: "read" });
    if (ok !== "granted") { toast("폴더 접근 권한이 필요해요."); return; }
    busy("폴더를 읽는 중…");
    await adopt(await walkDir(handle), handle.name);
  });

  // ---------- GitHub ----------
  githubPanel(els, toast, async (provider) => {
    busy("저장소를 읽는 중…");
    // the failure has to reach the panel, not stop here: swallowing it let a
    // rejected token be saved and shown as connected while nothing had loaded
    try { await adopt(await provider.entries(), provider.label); }
    finally { busy(null); }
  });

  // ---------- browsing ----------
  // ---------- what has been read ----------
  const SHELF_KEY = "manhwa-shelf";
  let shelf = loadShelf();
  function loadShelf() {
    try { return JSON.parse(localStorage.getItem(SHELF_KEY) || "{}"); } catch (e) { return {}; }
  }
  function saveShelf() {
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(shelf)); } catch (e) {}
  }

  let filter = { query: "", status: "all" };

  // ---------- browsing ----------
  function render() {
    busy(null);
    els.libEmpty.hidden = series.length > 0;
    els.libBody.hidden = series.length === 0;
    if (!series.length) return;

    els.libSource.textContent = sourceLabel;
    els.shelfTools.hidden = !current;          // the tools belong to a chapter list
    if (current) renderChapters(); else renderSeries();
  }

  function renderSeries() {
    els.libCrumbs.innerHTML = "";
    els.chapterList.hidden = true;
    els.seriesGrid.hidden = false;
    els.seriesGrid.innerHTML = "";
    for (const s of sortSeries(series, shelf)) {
      const total = s.chapters.reduce((n, c) => n + c.pages.length, 0);
      const p = seriesProgress(shelf, s.name, s.chapters);
      const next = nextUnread(shelf, s.name, s.chapters);
      const card = document.createElement("button");
      card.className = "card series-card";
      card.innerHTML =
        '<span class="series-name"></span>'
        + '<span class="series-meta mono">' + s.chapters.length + "화 · " + total + "쪽</span>"
        + (p.done || p.started
            ? '<span class="series-mark"></span><span class="series-bar"><i></i></span>'
            : "");
      card.querySelector(".series-name").textContent = s.name;
      if (p.done || p.started) {
        card.querySelector(".series-mark").textContent =
          !next ? "다 읽었어요" : p.done + " / " + p.total + "화 읽음 · 다음 " + next.name;
        card.querySelector(".series-bar i").style.width =
          Math.round((p.done / Math.max(1, p.total)) * 100) + "%";
      }
      card.addEventListener("click", () => { current = s; filter.query = ""; els.chapSearch.value = ""; render(); });
      els.seriesGrid.appendChild(card);
    }
  }

  function renderChapters() {
    els.seriesGrid.hidden = true;
    els.chapterList.hidden = false;
    els.libCrumbs.innerHTML = "";
    const back = document.createElement("button");
    back.className = "crumb-back";
    back.textContent = "‹ 시리즈 목록";
    back.addEventListener("click", () => { current = null; render(); });
    els.libCrumbs.appendChild(back);
    const here = document.createElement("span");
    here.className = "crumb-here";
    here.textContent = current.name;
    els.libCrumbs.appendChild(here);

    const next = nextUnread(shelf, current.name, current.chapters);
    els.continueBtn.hidden = !next;
    if (next) els.continueBtn.textContent = next.name + " 이어 읽기";

    const shown = filterChapters(current.chapters, {
      query: filter.query, status: filter.status, state: shelf, series: current.name
    });
    els.chapterList.innerHTML = "";
    if (!shown.length) {
      const none = document.createElement("p");
      none.className = "lib-empty-note";
      none.textContent = filter.query ? "그런 화를 찾지 못했어요." : "여기 해당하는 화가 없어요.";
      els.chapterList.appendChild(none);
      return;
    }

    for (const c of shown) {
      const i = current.chapters.indexOf(c);
      const prog = chapterProgress(shelf, current.name, c.name);
      const row = document.createElement("button");
      row.className = "chapter-row" + (prog.done ? " done" : "")
        + (prog.read && !prog.done ? " reading" : "");
      // a capture's page count is unknown until it has been measured, so say
      // what will happen instead of stating a number that is really a file count
      const known = knownCount(current, c);
      const note = stripMode ? (known ? known + "쪽" : "자동 분할") : c.pages.length + "쪽";
      row.innerHTML = '<span class="tick"></span><span class="ch-name"></span>'
        + '<span class="bar"><i></i></span>'
        + '<span class="ch-pages mono">' + note + "</span>";
      row.querySelector(".tick").textContent = prog.done ? "✓" : "";
      row.querySelector(".ch-name").textContent =
        c.number != null ? c.name : c.name + " (번호 없음)";
      row.querySelector(".bar i").style.width = Math.round(prog.ratio * 100) + "%";
      row.querySelector(".bar").style.visibility = prog.read ? "visible" : "hidden";
      row.addEventListener("click", () => {
        read(i, prog.done ? 0 : prog.page)
          .catch((err) => { busy(null); toast("이 화를 열지 못했어요."); console.error(err); });
      });
      els.chapterList.appendChild(row);
    }
  }

  els.chapSearch.addEventListener("input", () => {
    filter.query = els.chapSearch.value;
    if (current) renderChapters();
  });
  for (const chip of els.shelfTools.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      filter.status = chip.dataset.status;
      for (const c of els.shelfTools.querySelectorAll(".chip")) c.classList.toggle("on", c === chip);
      if (current) renderChapters();
    });
  }
  els.continueBtn.addEventListener("click", () => {
    const next = nextUnread(shelf, current.name, current.chapters);
    if (!next) return;
    const i = current.chapters.indexOf(next);
    const prog = chapterProgress(shelf, current.name, next.name);
    read(i, prog.page).catch((err) => { busy(null); toast("이 화를 열지 못했어요."); console.error(err); });
  });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- uncut captures ----------
  /**
   * A chapter's measurement, and the rectangles that follow from it.
   *
   * Measuring is the expensive half and never changes; the rectangles are cheap
   * and get recomputed whenever somebody disagrees with the automatic page
   * count. Keeping both is what makes that argument instant.
   */
  const chapterKey = (seriesObj, c) => seriesObj.name + "/" + c.name;

  /**
   * Rectangles kept between visits.
   *
   * Measuring a forty-thousand-pixel capture takes seconds, and the answer never
   * changes — the file is the same file. Keeping only the rectangles means a
   * chapter reopens instantly while the pixels stay where they were; the
   * measurement itself is far too large to hold.
   *
   * Keyed by size as well as name so a re-uploaded capture is measured again
   * rather than read through a stale plan.
   */
  const CUTS_KEY = "manhwa-cuts";
  function loadCuts(k, stamp) {
    try {
      const all = JSON.parse(localStorage.getItem(CUTS_KEY) || "{}");
      const e = all[k];
      return e && e.stamp === stamp ? e.pages : null;
    } catch (e) { return null; }
  }
  function saveCuts(k, stamp, pages) {
    try {
      const all = JSON.parse(localStorage.getItem(CUTS_KEY) || "{}");
      all[k] = { stamp, pages, at: Date.now() };
      // a shelf of hundreds would eventually fill the quota; drop the oldest
      const keys = Object.keys(all);
      if (keys.length > 400) {
        keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
        for (const dead of keys.slice(0, keys.length - 400)) delete all[dead];
      }
      localStorage.setItem(CUTS_KEY, JSON.stringify(all));
    } catch (e) { /* out of room: measuring again is slow, not broken */ }
  }
  const stampOf = (c) => c.pages.map((p) => p.name + ":" + (p.size || 0)).join("|");

  /** Pages this chapter is known to hold — from this session or a past one. */
  function knownCount(seriesObj, c) {
    const k = chapterKey(seriesObj, c);
    const here = plans.get(k);
    if (here) return here.pages.length;
    const kept = loadCuts(k, stampOf(c));
    return kept ? kept.length : 0;
  }

  async function planFor(seriesObj, c) {
    const k = chapterKey(seriesObj, c);
    if (plans.has(k)) return plans.get(k);

    const stamp = stampOf(c);
    const kept = loadCuts(k, stamp);
    if (kept && kept.length) {
      // measures are absent, so the page count cannot be argued with until the
      // chapter has been measured once in this session
      const entry = { measures: null, pages: kept };
      plans.set(k, entry);
      return entry;
    }

    const total = c.pages.length;
    busy(total > 1 ? "페이지를 찾는 중… (0/" + total + ")" : "페이지를 찾는 중…");
    const { measures, pages } = await sliceChapter(c.pages, (done, n) => {
      if (n > 1) busy("페이지를 찾는 중… (" + done + "/" + n + ")");
    });
    busy(null);
    const split = loadSplit(k);
    const entry = { measures, pages: split ? pagesFrom(measures, { pageCount: split }) : pages };
    plans.set(k, entry);
    saveCuts(k, stamp, entry.pages);
    return entry;
  }

  /**
   * How many pages this chapter was told to have.
   *
   * Automatic detection reads the format off the paper, and on captures whose
   * pages are separated by promotional strips it can be some way out. Rather
   * than leave such a chapter unreadable, the count is adjustable — and the
   * choice is remembered, because a capture is wrong the same way every time.
   */
  const SPLIT_KEY = "manhwa-split";
  function loadSplit(k) {
    try { return (JSON.parse(localStorage.getItem(SPLIT_KEY) || "{}"))[k] || null; }
    catch (e) { return null; }
  }
  function saveSplit(k, n) {
    try {
      const all = JSON.parse(localStorage.getItem(SPLIT_KEY) || "{}");
      if (n) all[k] = n; else delete all[k];
      localStorage.setItem(SPLIT_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function busy(msg) {
    els.libStatus.innerHTML = "";
    els.libStatus.hidden = !msg;
    if (!msg) return;
    const dot = document.createElement("span");
    dot.className = "spinner";
    const text = document.createElement("span");
    text.textContent = msg;
    els.libStatus.append(dot, text);
  }

  // ---------- reading ----------
  /** Build a source for chapter `i`, wired to roll into its neighbours. */
  async function chapterSource(seriesObj, i) {
    const c = seriesObj.chapters[i];
    if (!c) return null;
    const id = "lib:" + seriesObj.name + "/" + c.name;
    const next = i + 1 < seriesObj.chapters.length
      ? () => chapterSource(seriesObj, i + 1) : null;
    const prev = i > 0 ? () => chapterSource(seriesObj, i - 1) : null;

    const entry = stripMode ? await planFor(seriesObj, c) : null;
    const src = stripMode
      ? slicedSource({
          id, title: c.name,
          pages: entry.pages,
          // the decoded bitmap is handed over as it is. Copying it onto a canvas
          // first would double the memory a capture costs for nothing — drawing
          // takes a bitmap directly, and only measuring needs readable pixels.
          load: async (fileIndex) => decodeBlob(await c.pages[fileIndex].load()),
          nextChapter: next, prevChapter: prev
        })
      : imageListSource({
          id, title: c.name,
          items: c.pages,
          decode: async (item) => decodeBlob(await item.load()),
          nextChapter: next, prevChapter: prev
        });
    src.seriesName = seriesObj.name;
    if (entry) {
      const k = chapterKey(seriesObj, c);
      src.pageSplit = {
        auto: entry.measures ? pagesFrom(entry.measures).length : entry.pages.length,
        current: entry.pages.length,
        async set(n) {
          const want = Math.max(1, Math.min(500, Math.round(n)));
          // a plan read back from storage has no measurement behind it; take one
          // now so the count can be argued with
          if (!entry.measures) {
            busy("페이지를 다시 재는 중…");
            const fresh = await sliceChapter(c.pages, null);
            entry.measures = fresh.measures;
            busy(null);
            this.auto = pagesFrom(entry.measures).length;
          }
          const auto = want === this.auto;
          entry.pages = pagesFrom(entry.measures, auto ? {} : { pageCount: want });
          saveSplit(k, auto ? null : want);
          saveCuts(k, stampOf(c), entry.pages);
          this.current = entry.pages.length;
          return entry.pages;
        }
      };
    }
    return src;
  }

  async function read(i, startPage) {
    const src = await chapterSource(current, i);
    if (!src || !src.count) { busy(null); toast("이 화에서 페이지를 찾지 못했어요."); return; }
    openReader(src, startPage || 0);
  }

  // remember where the reader got to, so 이어보기 knows
  function onProgress(src, page) {
    if (!src || !src.seriesName) return;
    noteProgress(src.seriesName, src.title, page, src.count);
    shelf = noteRead(shelf, src.seriesName, src.title, page, src.count);
    saveShelf();
  }

  /**
   * Open a pinned page, wherever it lives.
   *
   * A pin carries the names it was made under, not a handle to anything — the
   * files behind it may not even be loaded. So the names are looked up in
   * whatever library is open now, and a pin from a folder that is no longer
   * loaded politely says so rather than doing nothing.
   */
  async function jumpTo(pin) {
    const s = series.find((x) => x.name === pin.series);
    if (!s) return false;
    const i = s.chapters.findIndex((c) => c.name === pin.chapter);
    if (i < 0) return false;
    current = s;
    render();
    await read(i, pin.page || 0);
    return true;
  }

  /**
   * The most recently read thing, for the home screen.
   *
   * Progress is kept per series rather than as one "last read" value, so the
   * newest entry has to be found rather than looked up — which is the right
   * trade: reading two series in parallel is normal, and each keeps its own place.
   */
  function lastRead() {
    let best = null;
    for (const [name, p] of Object.entries(allProgress())) {
      if (!best || (p.at || 0) > (best.at || 0)) best = { series: name, ...p };
    }
    return best;
  }

  /**
   * Pick up where reading stopped.
   *
   * If nothing is loaded, the folder is re-opened first — but only where the
   * browser kept permission for it. Everywhere else this can do no more than
   * take the reader to the picker, because the files are simply not reachable
   * without asking again.
   */
  async function resume() {
    const last = lastRead();
    if (!last) return false;
    if (!series.length) {
      const handle = await storedHandle();
      if (!handle) return false;
      let ok = await handle.queryPermission({ mode: "read" });
      if (ok !== "granted") ok = await handle.requestPermission({ mode: "read" });
      if (ok !== "granted") return false;
      busy("폴더를 읽는 중…");
      await adopt(await walkDir(handle), handle.name);
    }
    const s = series.find((x) => x.name === last.series);
    if (!s) return false;
    current = s;
    render();
    const i = s.chapters.findIndex((c) => c.name === last.chapter);
    if (i < 0) return false;
    await read(i, last.page || 0);
    return true;
  }

  (async () => {
    const handle = await storedHandle();
    if (handle) showResume(handle.name);
    els.pickFolderBtn.textContent = hasFSA ? "폴더 선택" : "폴더 선택 (하위 폴더 포함)";
  })();

  return { onProgress, refresh: render, lastRead, resume, jumpTo };
}
