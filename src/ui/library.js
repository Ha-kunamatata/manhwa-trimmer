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
  function render() {
    busy(null);
    els.libEmpty.hidden = series.length > 0;
    els.libBody.hidden = series.length === 0;
    if (!series.length) return;

    els.libSource.textContent = sourceLabel;
    const progress = allProgress();

    if (!current) {
      els.libCrumbs.innerHTML = "";
      els.chapterList.hidden = true;
      els.seriesGrid.hidden = false;
      els.seriesGrid.innerHTML = "";
      for (const s of series) {
        const total = s.chapters.reduce((n, c) => n + c.pages.length, 0);
        const p = progress[s.name];
        const card = document.createElement("button");
        card.className = "card series-card";
        card.innerHTML =
          '<span class="series-name"></span>'
          + '<span class="series-meta mono">' + s.chapters.length + "화 · " + total + "쪽</span>"
          + (p ? '<span class="series-mark">이어보기 · ' + esc(p.chapter) + " " + (p.page + 1) + "쪽</span>" : "");
        card.querySelector(".series-name").textContent = s.name;
        card.addEventListener("click", () => { current = s; render(); });
        els.seriesGrid.appendChild(card);
      }
      return;
    }

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

    const p = progress[current.name];
    els.chapterList.innerHTML = "";
    current.chapters.forEach((c, i) => {
      const row = document.createElement("button");
      row.className = "chapter-row" + (p && p.chapter === c.name ? " reading" : "");
      // a capture's page count is unknown until it has been measured, so say
      // what will happen instead of stating a number that is really a file count
      const known = plans.get(current.name + "/" + c.name);
      const note = stripMode
        ? (known ? known.length + "쪽" : "자동 분할")
        : c.pages.length + "쪽";
      row.innerHTML = '<span class="ch-name"></span><span class="ch-pages mono">' + note + "</span>";
      row.querySelector(".ch-name").textContent =
        c.number != null ? c.name : c.name + " (번호 없음)";
      row.addEventListener("click", () => {
        read(i, p && p.chapter === c.name ? p.page : 0)
          .catch((err) => { busy(null); toast("이 화를 열지 못했어요."); console.error(err); });
      });
      els.chapterList.appendChild(row);
    });
  }

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

  async function planFor(seriesObj, c) {
    const k = chapterKey(seriesObj, c);
    if (plans.has(k)) return plans.get(k);
    const total = c.pages.length;
    busy(total > 1 ? "페이지를 찾는 중… (0/" + total + ")" : "페이지를 찾는 중…");
    const { measures, pages } = await sliceChapter(c.pages, (done, n) => {
      if (n > 1) busy("페이지를 찾는 중… (" + done + "/" + n + ")");
    });
    busy(null);
    const split = loadSplit(k);
    const entry = { measures, pages: split ? pagesFrom(measures, { pageCount: split }) : pages };
    plans.set(k, entry);
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
        auto: pagesFrom(entry.measures).length,
        current: entry.pages.length,
        set(n) {
          const want = Math.max(1, Math.min(500, Math.round(n)));
          const auto = want === this.auto;
          entry.pages = pagesFrom(entry.measures, auto ? {} : { pageCount: want });
          saveSplit(k, auto ? null : want);
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
    if (src && src.seriesName) noteProgress(src.seriesName, src.title, page, src.count);
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
