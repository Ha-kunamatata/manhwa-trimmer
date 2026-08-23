/**
 * The trimmer — intake, controls, preview, results and export.
 *
 * All page-geometry decisions live in ../core/*, which is pure and unit tested.
 * This file owns the DOM for the editing half of the app. Reading is somebody
 * else's job: when the user wants to read, this hands over a page source
 * (see ./sources.js) and steps back.
 */
import { analyseStrip } from "../core/analysis.js";
import {
  detectColumns, detectRows, buildBandMap, findBlankBands,
  autoFit, computePages, clamp
} from "../core/geometry.js";
import { buildPdf } from "../core/pdf.js";
import { stripSource } from "./sources.js";

export function initEditor(openReader, toast) {

  const $ = (s, r) => (r || document).querySelector(s);

  const state = {
    file: null, url: null, img: null,
    natW: 0, natH: 0,
    canvas: null, ctx: null,
    brightness: null, variance: null, saturation: null,
    colInk: null, colStep: 1, grayRows: 0,
    autoL: 0, autoR: 0, autoT: 0, autoB: 0,
    cuts: [], pages: [], autoFit: null, bandThick: null, bandRef: 4,
    blankBands: [],
    manualAdds: [], manualRemoves: [],
    userPageCount: null
  };

  const els = {
    dropzone: $("#dropzone"), fileInput: $("#fileInput"), rail: $("#rail"),
    previewPanel: $("#previewPanel"), previewFrame: $("#previewFrame"), previewImg: $("#previewImg"),
    filenameLabel: $("#filenameLabel"), statusLine: $("#statusLine"), statusText: $("#statusText"),
    results: $("#results"), statsBar: $("#statsBar"), pageGrid: $("#pageGrid"),
    areaSummary: $("#areaSummary"),
    cropLeft: $("#cropLeft"), cropRight: $("#cropRight"), cropTop: $("#cropTop"), cropBottom: $("#cropBottom"),
    redetectBtn: $("#redetectBtn"),
    ratioSel: $("#ratioSel"), targetVal: $("#targetVal"), ratioHint: $("#ratioHint"),
    customRatioWrap: $("#customRatioWrap"), customRatio: $("#customRatio"),
    pageCount: $("#pageCount"), startOffset: $("#startOffset"),
    clearManualBtn: $("#clearManualBtn"), manualCount: $("#manualCount"),
    baseName: $("#baseName"), fmtToggle: $("#fmtToggle"), fmtHint: $("#fmtHint"),
    resetBtn: $("#resetBtn"), downloadAllBtn: $("#downloadAllBtn"),
    downloadPdfBtn: $("#downloadPdfBtn"), readBtn: $("#readBtn")
  };

  const fmtInt = (n) => Math.round(n).toLocaleString("ko-KR");
  const num = (el) => Number(el.value) || 0;
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  const switchGet = (b) => b.getAttribute("aria-checked") === "true";
  const switchSet = (b, v) => b.setAttribute("aria-checked", v ? "true" : "false");

  function saveSettings() {
    try {
      localStorage.setItem("manhwa-trimmer-v2", JSON.stringify({
        ratio: els.ratioSel.value, customRatio: els.customRatio.value, hiQ: switchGet(els.fmtToggle)
      }));
    } catch (e) {}
  }
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("manhwa-trimmer-v2") || "null");
      if (!s) return;
      if (s.ratio) els.ratioSel.value = s.ratio;
      if (s.customRatio) els.customRatio.value = s.customRatio;
      if (s.hiQ != null) switchSet(els.fmtToggle, s.hiQ);
    } catch (e) {}
  }

  /** What the Claude host will accept in one save. */
  const MAX_BYTES = 15.4 * 1024 * 1024;

  /**
   * Somewhere to put a finished file.
   *
   * Inside a Claude Artifact the host owns saving and hands back a `save`. On
   * the hosted page there is no host, so the browser's own download is used —
   * without this the whole export half of the app is dead everywhere except an
   * artifact, which is exactly where it is least likely to be used.
   *
   * `limit` is what makes the difference visible: the host caps a single save,
   * a browser download does not, so a long comic keeps its quality on the web
   * instead of being shrunk to fit a ceiling that isn't there.
   */
  async function getDownloads() {
    if (window.claude && typeof window.claude.use === "function") {
      try {
        const dl = await window.claude.use("downloads");
        if (dl) return Object.assign({ limit: MAX_BYTES }, dl);
      } catch (e) { /* fall through to the browser */ }
    }
    return {
      limit: Infinity,          // a browser download has no size ceiling
      save: ({ filename, data }) => new Promise((resolve, reject) => {
        try {
          const blob = data instanceof Blob ? data
            : new Blob([data], { type: /\.pdf$/i.test(filename) ? "application/pdf" : "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          // revoking too early cancels the download in some browsers
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          resolve({ status: "saved" });
        } catch (err) { reject(err); }
      })
    };
  }

  // ---------- intake ----------
  const openPicker = () => els.fileInput.click();
  els.dropzone.addEventListener("click", openPicker);
  els.dropzone.querySelector(".btn").addEventListener("click", (e) => { e.stopPropagation(); openPicker(); });
  els.fileInput.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) loadFile(f); });
  ["dragenter", "dragover"].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove("drag"); }));
  els.dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });

  function loadFile(file) {
    if (!file.type.startsWith("image/")) { toast("이미지 파일만 올릴 수 있어요."); return; }
    state.file = file;
    els.baseName.value = file.name.replace(/\.[^.]+$/, "") || "page";
    els.filenameLabel.textContent = file.name;
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.img = img; state.natW = img.naturalWidth; state.natH = img.naturalHeight;
      state.manualAdds = []; state.manualRemoves = []; state.userPageCount = null;
      els.previewImg.src = state.url;
      els.rail.hidden = false; els.previewPanel.hidden = false; els.dropzone.hidden = true;
      analyze();
    };
    img.onerror = () => toast("이미지를 불러오지 못했어요.");
    img.src = state.url;
  }

  els.resetBtn.addEventListener("click", () => {
    state.file = null; state.img = null;
    if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
    state.canvas = null; state.brightness = null; state.colInk = null;
    state.cuts = []; state.pages = []; state.blankBands = [];
    state.manualAdds = []; state.manualRemoves = []; state.userPageCount = null;
    els.rail.hidden = true; els.previewPanel.hidden = true; els.results.hidden = true;
    els.dropzone.hidden = false; els.fileInput.value = "";
    clearOverlay();
  });

  // ---------- analysis ----------
  async function analyze() {
    els.statusLine.hidden = false;
    els.statusText.textContent = "이미지 분석 중… 0%";

    const w = state.natW, h = state.natH;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(state.img, 0, 0);
    state.canvas = canvas; state.ctx = ctx;

    let stats;
    try {
      stats = await analyseStrip(ctx, w, h, {
        onProgress: (f) => { els.statusText.textContent = "이미지 분석 중… " + Math.min(99, Math.round(f * 100)) + "%"; },
        yieldFn: () => new Promise((r) => setTimeout(r, 0))
      });
    } catch (e) {
      toast("이미지가 너무 커서 분석할 수 없어요.");
      els.statusLine.hidden = true;
      return;
    }

    Object.assign(state, stats);
    els.statusLine.hidden = true;

    autoDetect();
    els.cropLeft.value = state.autoL; els.cropRight.value = state.autoR;
    els.cropTop.value = state.autoT; els.cropBottom.value = state.autoB;
    state.userPageCount = null;
    recompute();
  }

  function autoDetect() {
    const cols = detectColumns({
      colInk: state.colInk, colStep: state.colStep,
      grayRows: state.grayRows, width: state.natW
    });
    state.autoL = cols.cropLeft;
    state.autoR = cols.cropRight;
    const rows = detectRows({
      variance: state.variance, saturation: state.saturation,
      height: state.natH
    });
    state.autoT = rows.top;
    state.autoB = rows.bottom;
  }

  els.redetectBtn.addEventListener("click", () => {
    if (!state.brightness) return;
    autoDetect();
    els.cropLeft.value = state.autoL; els.cropRight.value = state.autoR;
    els.cropTop.value = state.autoT; els.cropBottom.value = state.autoB;
    recompute();
  });

  // ---------- the layout guide ----------
  function box() {
    const w = state.natW, h = state.natH;
    const l = clamp(num(els.cropLeft), 0, w - 10);
    const r = clamp(num(els.cropRight), 0, w - l - 10);
    const t = clamp(num(els.cropTop), 0, h - 10);
    const b = clamp(num(els.cropBottom), 0, h - t - 10);
    return { left: l, right: w - r, top: t, bottom: h - b, width: w - l - r, height: h - t - b };
  }
  function ratio() {
    return els.ratioSel.value === "custom"
      ? clamp(Number(els.customRatio.value) || 1.41, 0.4, 5)
      : Number(els.ratioSel.value);
  }

  function recompute() {
    if (!state.brightness) return;
    const bx = box();
    const offset = num(els.startOffset);
    const span = bx.height - offset;
    const auto = els.ratioSel.value === "auto";

    state.bands = buildBandMap(
      { brightness: state.brightness, variance: state.variance, height: state.natH }, bx);
    let fit = null;
    if (auto) {
      fit = autoFit(bx, offset, state.bands, state.natH);
      state.autoFit = fit;
    }
    const pageH = fit ? fit.height : bx.width * ratio();

    let n = state.userPageCount || (fit ? fit.n : Math.max(1, Math.round(span / pageH)));
    n = clamp(n, 1, 500);
    els.pageCount.value = n;

    const built = computePages({
      bx, offset,
      pageHeight: pageH,
      pageCount: n,
      bands: state.bands,
      height: state.natH,
      manualAdds: state.manualAdds,
      manualRemoves: state.manualRemoves
    });

    state.blankBands = findBlankBands(
      { brightness: state.brightness, variance: state.variance }, bx);
    state.cuts = built.cuts;
    state.pages = built.pages;

    els.targetVal.textContent = fmtInt(built.actualH) + "px";
    if (auto && state.autoFit) {
      const f = state.autoFit;
      const layout = f.across === 2 ? "두 페이지 펼침" : "한 페이지";
      els.ratioHint.textContent =
        layout + " 배치로 판단했어요. 페이지 폭 " + fmtInt(bx.width / f.across)
        + "px × " + f.ratio.toFixed(3) + " → " + n + "장, 경계 정확도 "
        + Math.round(f.score * 100) + "%.";
    } else {
      els.ratioHint.textContent =
        "만화 폭 " + fmtInt(bx.width) + "px × " + ratio().toFixed(3)
        + " = 한 페이지 " + fmtInt(pageH) + "px, " + n + "장으로 균등 분할했어요.";
    }
    els.areaSummary.textContent =
      "이미지 " + fmtInt(state.natW) + " × " + fmtInt(state.natH)
      + "px 중 만화 영역 " + fmtInt(bx.width) + " × " + fmtInt(bx.height) + "px";

    renderOverlay(bx);
    renderResults(bx);
    saveSettings();
  }
  const debouncedRecompute = debounce(recompute, 160);

  // ---------- overlay ----------
  function clearOverlay() {
    els.previewFrame.querySelectorAll(".crop-band,.crop-tag,.cut-line,.cut-tag,.side-band").forEach((n) => n.remove());
  }
  function renderOverlay(bx) {
    clearOverlay();
    const w = state.natW, h = state.natH;
    const add = (cls, style) => {
      const d = document.createElement("div"); d.className = cls;
      Object.assign(d.style, style); els.previewFrame.appendChild(d); return d;
    };
    if (bx.top > 0) add("crop-band", { top: "0%", height: (bx.top / h * 100) + "%" });
    if (bx.bottom < h) add("crop-band", { top: (bx.bottom / h * 100) + "%", height: ((h - bx.bottom) / h * 100) + "%" });
    if (bx.left > 0) add("side-band", { left: "0%", width: (bx.left / w * 100) + "%" });
    if (bx.right < w) add("side-band", { left: (bx.right / w * 100) + "%", width: ((w - bx.right) / w * 100) + "%" });

    state.cuts.forEach((c, idx) => {
      add("cut-line" + (c.manual ? " manual" : ""), { top: (c.y / h * 100) + "%" });
      const tag = add("cut-tag", { top: (c.y / h * 100) + "%" });
      tag.textContent = (c.manual ? "✎ " : "") + (idx + 1) + " / " + (idx + 2) + "p";
    });

    const edits = state.manualAdds.length + state.manualRemoves.length;
    els.clearManualBtn.hidden = edits === 0;
    els.manualCount.textContent = edits;
  }

  els.previewFrame.addEventListener("click", (e) => {
    if (!state.brightness) return;
    const rect = els.previewImg.getBoundingClientRect();
    if (rect.height <= 0) return;
    const y = Math.round((e.clientY - rect.top) / rect.height * state.natH);
    const bx = box();
    if (y <= bx.top || y >= bx.bottom) return;
    const tol = Math.max(20, state.natH * 0.004);
    const hit = state.cuts.find((c) => Math.abs(c.y - y) <= tol);
    if (hit) {
      state.manualAdds = state.manualAdds.filter((a) => Math.abs(a - hit.y) > tol);
      if (!hit.manual) state.manualRemoves.push(hit.y);
    } else {
      let snapped = y, bestD = Infinity;
      for (const b of state.blankBands) {
        const d = Math.abs(b - y);
        if (d < bestD && d <= tol * 4) { bestD = d; snapped = b; }
      }
      state.manualAdds.push(snapped);
      state.manualRemoves = state.manualRemoves.filter((r) => Math.abs(r - snapped) > tol);
    }
    recompute();
  });
  els.clearManualBtn.addEventListener("click", () => {
    state.manualAdds = []; state.manualRemoves = []; recompute();
  });

  // ---------- results ----------
  function renderResults(bx) {
    const pages = state.pages;
    els.results.hidden = pages.length === 0;
    if (!pages.length) return;

    els.statsBar.innerHTML = "";
    [["총 페이지", pages.length + "장"],
     ["페이지 크기", fmtInt(bx.width) + " × " + fmtInt(pages[0].height) + "px"],
     ["적용 비율", "1 : " + ratio().toFixed(3)],
     ["잘라낸 여백", fmtInt(state.natW - bx.width) + " × " + fmtInt(state.natH - bx.height) + "px"]
    ].forEach(([l, n]) => {
      const s = document.createElement("div"); s.className = "stat";
      s.innerHTML = '<span class="n mono">' + n + '</span><span class="l">' + l + "</span>";
      els.statsBar.appendChild(s);
    });

    els.pageGrid.innerHTML = "";
    pages.forEach((p, idx) => {
      const card = document.createElement("div"); card.className = "card page-card";
      const thumb = document.createElement("div"); thumb.className = "page-thumb"; card.appendChild(thumb);
      const meta = document.createElement("div"); meta.className = "page-meta";
      meta.innerHTML = '<span><span class="idx">' + String(idx + 1).padStart(2, "0") + "페이지</span>"
        + '<span class="h mono">' + fmtInt(p.height) + "px</span></span>";
      const b = document.createElement("button"); b.className = "icon-btn"; b.title = "이 페이지 저장";
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';
      b.addEventListener("click", (e) => { e.stopPropagation(); downloadPage(idx); });
      meta.appendChild(b); card.appendChild(meta);
      thumb.style.cursor = "zoom-in";
      thumb.title = "이 페이지부터 읽기";
      thumb.addEventListener("click", () => read(idx));
      els.pageGrid.appendChild(card);
    });
    requestAnimationFrame(layoutThumbs);
  }

  function layoutThumbs() {
    const bx = box();
    els.pageGrid.querySelectorAll(".page-thumb").forEach((thumb, idx) => {
      const p = state.pages[idx]; if (!p) return;
      const width = thumb.getBoundingClientRect().width || 148;
      const scale = width / bx.width;
      thumb.style.height = Math.round(p.height * scale) + "px";
      thumb.style.backgroundImage = "url(" + state.url + ")";
      thumb.style.backgroundSize = Math.round(state.natW * scale) + "px " + Math.round(state.natH * scale) + "px";
      thumb.style.backgroundPosition = "-" + Math.round(bx.left * scale) + "px -" + Math.round(p.start * scale) + "px";
    });
  }
  window.addEventListener("resize", debounce(layoutThumbs, 200));

  // ---------- reading what was just cut ----------
  function read(idx) {
    if (!state.pages.length) return;
    const name = (state.file && state.file.name) || "잘라낸 페이지";
    const src = stripSource({
      id: "strip:" + name,
      title: name,
      canvas: state.canvas,
      box: box(),
      pages: state.pages
    });
    src.seriesName = "방금 자른 만화";
    openReader(src, idx);
  }
  els.readBtn.addEventListener("click", () => read(null));

  // ---------- export ----------
  function pageToBlob(p) {
    const bx = box();
    const c = document.createElement("canvas");
    c.width = bx.width; c.height = p.height;
    c.getContext("2d").drawImage(state.canvas, bx.left, p.start, bx.width, p.height, 0, 0, bx.width, p.height);
    return new Promise((res) => switchGet(els.fmtToggle)
      ? c.toBlob((b) => res(b), "image/png")
      : c.toBlob((b) => res(b), "image/jpeg", 0.9));
  }
  function pageFilename(idx) {
    const base = (els.baseName.value || "page").trim().replace(/[\\/:*?"<>|]/g, "_") || "page";
    return base + "_" + String(idx + 1).padStart(2, "0") + "." + (switchGet(els.fmtToggle) ? "png" : "jpg");
  }
  function saveError(err, no) {
    const code = err && err.code;
    if (code === "declined") { toast("저장이 취소되어 멈췄어요."); return true; }
    if (code === "too_large") { toast((no ? no + "페이지 " : "") + "용량이 커서 건너뛰었어요. 고화질 PNG를 꺼보세요."); return false; }
    if (code === "rate_limited") { toast("저장 요청이 밀렸어요. 잠시 후 이어서 시도해주세요."); return true; }
    toast("저장 중 문제가 발생했어요."); return true;
  }
  async function downloadPage(idx) {
    const dl = await getDownloads();
    if (!dl) { toast("이 화면에서는 파일 저장을 사용할 수 없어요."); return; }
    try { await dl.save({ filename: pageFilename(idx), data: await pageToBlob(state.pages[idx]) }); }
    catch (err) { saveError(err); }
  }

  function pageJpeg(p, quality, scale) {
    const bx = box();
    const w = Math.max(1, Math.round(bx.width * scale));
    const h = Math.max(1, Math.round(p.height * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(state.canvas, bx.left, p.start, bx.width, p.height, 0, 0, w, h);
    return new Promise((res) => c.toBlob((b) => res({ blob: b, w, h }), "image/jpeg", quality));
  }

  els.downloadPdfBtn.addEventListener("click", async () => {
    const dl = await getDownloads();
    if (!dl) { toast("이 화면에서는 파일 저장을 사용할 수 없어요."); return; }
    const btn = els.downloadPdfBtn;
    const label = btn.innerHTML;
    btn.disabled = true;
    try {
      // shrink only as far as needed to fit the save limit — which the browser
      // does not impose, so a plain download keeps full quality however long
      // the comic is
      const cap = dl.limit == null ? MAX_BYTES : dl.limit;
      const tries = [[0.85, 1], [0.75, 1], [0.7, 0.8], [0.6, 0.65], [0.5, 0.5]];
      let pdf = null;
      for (let t = 0; t < tries.length; t++) {
        const [q, sc] = tries[t];
        const items = [];
        for (let i = 0; i < state.pages.length; i++) {
          btn.textContent = "PDF 만드는 중… (" + (i + 1) + "/" + state.pages.length + ")";
          const r = await pageJpeg(state.pages[i], q, sc);
          if (!r.blob) throw new Error("encode");
          items.push({ bytes: new Uint8Array(await r.blob.arrayBuffer()), w: r.w, h: r.h });
        }
        btn.textContent = "PDF 묶는 중…";
        pdf = buildPdf(items);
        if (pdf.length <= cap) break;
        if (t === tries.length - 1) { toast("페이지가 너무 많아 PDF 한 파일로 담기 어려워요. 낱장 저장을 써주세요."); pdf = null; }
      }
      if (pdf) {
        const base = (els.baseName.value || "comic").trim().replace(/[\\/:*?"<>|]/g, "_") || "comic";
        await dl.save({ filename: base + ".pdf", data: pdf });
      }
    } catch (err) {
      if (err && err.code === "extension_not_enabled") {
        toast("이 화면에서는 PDF 저장이 막혀 있어요. 낱장 이미지로 저장해주세요.");
      } else if (err && err.code === "declined") {
        // user said no; nothing to report
      } else {
        saveError(err);
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  });

  els.downloadAllBtn.addEventListener("click", async () => {
    const dl = await getDownloads();
    if (!dl) { toast("이 화면에서는 파일 저장을 사용할 수 없어요."); return; }
    els.downloadAllBtn.disabled = true;
    const total = state.pages.length;
    let stop = false;
    for (let i = 0; i < total && !stop; i++) {
      els.downloadAllBtn.textContent = "저장 중… (" + (i + 1) + "/" + total + ")";
      const blob = await pageToBlob(state.pages[i]);
      // the host throttles bursts of save prompts — back off and retry rather
      // than giving up, which is what dropped every page past the fifth
      for (let attempt = 0; attempt < 6; attempt++) {
        try { await dl.save({ filename: pageFilename(i), data: blob }); break; }
        catch (err) {
          if (err && err.code === "rate_limited") {
            els.downloadAllBtn.textContent = "잠시 대기 중… (" + (i + 1) + "/" + total + ")";
            await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
            continue;
          }
          if (saveError(err, i + 1)) stop = true;
          break;
        }
      }
    }
    els.downloadAllBtn.disabled = false;
    els.downloadAllBtn.textContent = "낱장 이미지로 저장";
  });

  // ---------- wiring ----------
  els.ratioSel.addEventListener("change", () => {
    els.customRatioWrap.hidden = els.ratioSel.value !== "custom";
    state.userPageCount = null;
    recompute();
  });
  els.customRatio.addEventListener("input", () => { state.userPageCount = null; debouncedRecompute(); });
  [els.cropLeft, els.cropRight, els.cropTop, els.cropBottom].forEach((el) =>
    el.addEventListener("input", () => { state.userPageCount = null; debouncedRecompute(); }));
  els.pageCount.addEventListener("input", () => {
    state.userPageCount = clamp(Math.round(num(els.pageCount)), 1, 500);
    debouncedRecompute();
  });
  els.startOffset.addEventListener("input", debouncedRecompute);
  els.baseName.addEventListener("input", saveSettings);
  els.fmtToggle.addEventListener("click", () => {
    switchSet(els.fmtToggle, !switchGet(els.fmtToggle));
    els.fmtHint.textContent = switchGet(els.fmtToggle)
      ? "끄면 JPEG로 저장해 파일 용량을 줄입니다."
      : "JPEG로 저장됩니다 (용량 작음, 화질 약간 손실).";
    saveSettings();
  });

  loadSettings();
  els.customRatioWrap.hidden = els.ratioSel.value !== "custom";
}
