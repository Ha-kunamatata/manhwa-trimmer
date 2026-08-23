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
import { buildLibrary } from "../core/naming.js";
import { imageListSource, decodeBlob } from "./sources.js";
import { createGithubProvider, githubPanel } from "./github.js";

export function createLibrary(els, openReader, toast) {
  let series = [];             // [{ name, chapters:[{ name, pages }] }]
  let sourceLabel = "";
  let current = null;          // the series being browsed

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
    render();
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
      els.libStatus.textContent = "폴더를 읽는 중…";
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
    els.libStatus.textContent = "폴더를 읽는 중…";
    await adopt(await walkDir(handle), handle.name);
  });

  // ---------- GitHub ----------
  githubPanel(els, toast, async (provider) => {
    els.libStatus.textContent = "저장소를 읽는 중…";
    try { await adopt(await provider.entries(), provider.label); }
    catch (err) { els.libStatus.textContent = ""; toast(err.message || "저장소를 읽지 못했어요."); }
  });

  // ---------- browsing ----------
  function render() {
    els.libStatus.textContent = "";
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
      row.innerHTML =
        '<span class="ch-name"></span>'
        + '<span class="ch-pages mono">' + c.pages.length + "쪽</span>";
      row.querySelector(".ch-name").textContent =
        c.number != null ? c.name : c.name + " (번호 없음)";
      row.addEventListener("click", () => read(i, p && p.chapter === c.name ? p.page : 0));
      els.chapterList.appendChild(row);
    });
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- reading ----------
  /** Build a source for chapter `i`, wired to roll into its neighbours. */
  function chapterSource(seriesObj, i) {
    const c = seriesObj.chapters[i];
    if (!c) return null;
    const src = imageListSource({
      id: "lib:" + seriesObj.name + "/" + c.name,
      title: c.name,
      items: c.pages,
      decode: async (item) => decodeBlob(await item.load()),
      nextChapter: i + 1 < seriesObj.chapters.length
        ? async () => chapterSource(seriesObj, i + 1) : null,
      prevChapter: i > 0 ? async () => chapterSource(seriesObj, i - 1) : null
    });
    src.seriesName = seriesObj.name;
    return src;
  }

  function read(i, startPage) {
    const src = chapterSource(current, i);
    if (!src) return;
    openReader(src, startPage || 0);
  }

  // remember where the reader got to, so 이어보기 knows
  function onProgress(src, page) {
    if (src && src.seriesName) noteProgress(src.seriesName, src.title, page, src.count);
  }

  (async () => {
    const handle = await storedHandle();
    if (handle) showResume(handle.name);
    els.pickFolderBtn.textContent = hasFSA ? "폴더 선택" : "폴더 선택 (하위 폴더 포함)";
  })();

  return { onProgress, refresh: render };
}
