/**
 * Manhwa Trimmer — UI layer.
 *
 * All page-geometry decisions live in ../core/*, which is pure and unit
 * tested. This file owns the DOM: intake, controls, preview, results, export
 * and the built-in reader.
 */
import { analyseStrip } from "../core/analysis.js";
import {
  detectColumns, detectRows, buildBandMap, findBlankBands,
  autoFit, computePages, clamp
} from "../core/geometry.js";
import { buildPdf } from "../core/pdf.js";

export function initApp(){

  const $ = (s, r) => (r||document).querySelector(s);

  const state = {
    file:null, url:null, img:null,
    natW:0, natH:0,
    canvas:null, ctx:null,
    brightness:null, variance:null, saturation:null,
    colInk:null, colStep:1, grayRows:0,
    autoL:0, autoR:0, autoT:0, autoB:0,
    cuts:[], pages:[], autoFit:null, bandThick:null, bandRef:4,
    blankBands:[],
    manualAdds:[], manualRemoves:[],
    userPageCount:null
  };

  const els = {
    dropzone:$("#dropzone"), fileInput:$("#fileInput"), rail:$("#rail"),
    previewPanel:$("#previewPanel"), previewFrame:$("#previewFrame"), previewImg:$("#previewImg"),
    filenameLabel:$("#filenameLabel"), statusLine:$("#statusLine"), statusText:$("#statusText"),
    results:$("#results"), statsBar:$("#statsBar"), pageGrid:$("#pageGrid"),
    areaSummary:$("#areaSummary"),
    cropLeft:$("#cropLeft"), cropRight:$("#cropRight"), cropTop:$("#cropTop"), cropBottom:$("#cropBottom"),
    redetectBtn:$("#redetectBtn"),
    ratioSel:$("#ratioSel"), targetVal:$("#targetVal"), ratioHint:$("#ratioHint"),
    customRatioWrap:$("#customRatioWrap"), customRatio:$("#customRatio"),
    pageCount:$("#pageCount"), startOffset:$("#startOffset"),
    clearManualBtn:$("#clearManualBtn"), manualCount:$("#manualCount"),
    baseName:$("#baseName"), fmtToggle:$("#fmtToggle"), fmtHint:$("#fmtHint"),
    resetBtn:$("#resetBtn"), downloadAllBtn:$("#downloadAllBtn"),
    downloadPdfBtn:$("#downloadPdfBtn"), readBtn:$("#readBtn")
  };

  const fmtInt = n => Math.round(n).toLocaleString("ko-KR");
  const num = el => Number(el.value) || 0;
  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
  function toast(msg){
    const t=document.createElement("div"); t.className="toast"; t.textContent=msg;
    document.body.appendChild(t); setTimeout(()=>t.remove(), 3200);
  }
  const switchGet = b => b.getAttribute("aria-checked")==="true";
  const switchSet = (b,v) => b.setAttribute("aria-checked", v?"true":"false");

  function saveSettings(){
    try{ localStorage.setItem("manhwa-trimmer-v2", JSON.stringify({
      ratio: els.ratioSel.value, customRatio: els.customRatio.value, hiQ: switchGet(els.fmtToggle)
    })); }catch(e){}
  }
  function loadSettings(){
    try{
      const s = JSON.parse(localStorage.getItem("manhwa-trimmer-v2")||"null");
      if(!s) return;
      if(s.ratio) els.ratioSel.value = s.ratio;
      if(s.customRatio) els.customRatio.value = s.customRatio;
      if(s.hiQ!=null) switchSet(els.fmtToggle, s.hiQ);
    }catch(e){}
  }

  async function getDownloads(){
    if(!window.claude || typeof window.claude.use !== "function") return null;
    try{ return await window.claude.use("downloads"); }catch(e){ return null; }
  }

  // ---------- intake ----------
  const openPicker = () => els.fileInput.click();
  els.dropzone.addEventListener("click", openPicker);
  els.dropzone.querySelector(".btn").addEventListener("click", e=>{ e.stopPropagation(); openPicker(); });
  els.fileInput.addEventListener("change", e=>{ const f=e.target.files&&e.target.files[0]; if(f) loadFile(f); });
  ["dragenter","dragover"].forEach(ev=>els.dropzone.addEventListener(ev,e=>{e.preventDefault();els.dropzone.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>els.dropzone.addEventListener(ev,e=>{e.preventDefault();els.dropzone.classList.remove("drag");}));
  els.dropzone.addEventListener("drop", e=>{ const f=e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) loadFile(f); });

  function loadFile(file){
    if(!file.type.startsWith("image/")){ toast("이미지 파일만 올릴 수 있어요."); return; }
    state.file = file;
    els.baseName.value = file.name.replace(/\.[^.]+$/, "") || "page";
    els.filenameLabel.textContent = file.name;
    if(state.url) URL.revokeObjectURL(state.url);
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
    state.file=null; state.img=null;
    if(state.url){ URL.revokeObjectURL(state.url); state.url=null; }
    state.canvas=null; state.brightness=null; state.colInk=null;
    state.cuts=[]; state.pages=[]; state.blankBands=[];
    state.manualAdds=[]; state.manualRemoves=[]; state.userPageCount=null;
    els.rail.hidden=true; els.previewPanel.hidden=true; els.results.hidden=true;
    els.dropzone.hidden=false; els.fileInput.value="";
    clearOverlay();
  });

  // ---------- analysis ----------
  async function analyze(){
    els.statusLine.hidden = false;
    els.statusText.textContent = "이미지 분석 중… 0%";

    const w = state.natW, h = state.natH;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently:true });
    ctx.drawImage(state.img, 0, 0);
    state.canvas = canvas; state.ctx = ctx;

    let stats;
    try{
      stats = await analyseStrip(ctx, w, h, {
        onProgress: f => { els.statusText.textContent = "이미지 분석 중… " + Math.min(99, Math.round(f*100)) + "%"; },
        yieldFn: () => new Promise(r => setTimeout(r, 0))
      });
    }catch(e){
      toast("이미지가 너무 커서 분석할 수 없어요.");
      els.statusLine.hidden = true;
      return;
    }

    Object.assign(state, stats);
    els.statusLine.hidden = true;

    autoDetect();
    els.cropLeft.value = state.autoL; els.cropRight.value = state.autoR;
    els.cropTop.value = state.autoT;  els.cropBottom.value = state.autoB;
    state.userPageCount = null;
    recompute();
  }

  function autoDetect(){
    const cols = detectColumns({ colInk:state.colInk, colStep:state.colStep,
                                 grayRows:state.grayRows, width:state.natW });
    state.autoL = cols.cropLeft;
    state.autoR = cols.cropRight;
    const rows = detectRows({ variance:state.variance, saturation:state.saturation,
                              height:state.natH });
    state.autoT = rows.top;
    state.autoB = rows.bottom;
  }

  els.redetectBtn.addEventListener("click", () => {
    if(!state.brightness) return;
    autoDetect();
    els.cropLeft.value=state.autoL; els.cropRight.value=state.autoR;
    els.cropTop.value=state.autoT;  els.cropBottom.value=state.autoB;
    recompute();
  });

  // ---------- the layout guide ----------
  function box(){
    const w = state.natW, h = state.natH;
    const l = clamp(num(els.cropLeft), 0, w-10);
    const r = clamp(num(els.cropRight), 0, w-l-10);
    const t = clamp(num(els.cropTop), 0, h-10);
    const b = clamp(num(els.cropBottom), 0, h-t-10);
    return { left:l, right:w-r, top:t, bottom:h-b, width:w-l-r, height:h-t-b };
  }
  function ratio(){
    return els.ratioSel.value === "custom"
      ? clamp(Number(els.customRatio.value)||1.41, 0.4, 5)
      : Number(els.ratioSel.value);
  }

  // Blank bands are used only to nudge a hand-placed line into a gutter.

  // Thickness of the blank band each row belongs to. The margin BETWEEN two
  // printed pages is a thick white band; the gap between panels inside a page
  // is thin. Thickness is what separates a real page break from a panel gap.

  // Pull a grid line onto the centre of the nearest convincing blank band.


  // Standard comic-book geometry gives only a few possible page heights:
  // B6/A5 tankoubon is 1 : 1.41, and a scan may hold one page or a two-page
  // spread. Rather than assume, lay each candidate grid over the image and
  // keep the one whose page boundaries actually land in white gutters.

  function recompute(){
    if(!state.brightness) return;
    const bx = box();
    const offset = num(els.startOffset);
    const span = bx.height - offset;
    const auto = els.ratioSel.value === "auto";

    state.bands = buildBandMap(
      { brightness:state.brightness, variance:state.variance, height:state.natH }, bx);
    let fit = null;
    if(auto){
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
    const actualH = built.actualH;
    const cuts = built.cuts;
    const pages = built.pages;

    state.blankBands = findBlankBands(
      { brightness:state.brightness, variance:state.variance }, bx);
    state.cuts = cuts;
    state.pages = pages;

    els.targetVal.textContent = fmtInt(actualH) + "px";
    if(auto && state.autoFit){
      const f = state.autoFit;
      const layout = f.across === 2 ? "두 페이지 펼침" : "한 페이지";
      els.ratioHint.textContent =
        layout + " 배치로 판단했어요. 페이지 폭 " + fmtInt(bx.width/f.across)
        + "px × " + f.ratio.toFixed(3) + " → " + n + "장, 경계 정확도 "
        + Math.round(f.score*100) + "%.";
    }else{
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
  function clearOverlay(){
    els.previewFrame.querySelectorAll(".crop-band,.crop-tag,.cut-line,.cut-tag,.side-band").forEach(n=>n.remove());
  }
  function renderOverlay(bx){
    clearOverlay();
    const w = state.natW, h = state.natH;
    const add = (cls, style) => {
      const d = document.createElement("div"); d.className = cls;
      Object.assign(d.style, style); els.previewFrame.appendChild(d); return d;
    };
    if(bx.top > 0)     add("crop-band", { top:"0%", height:(bx.top/h*100)+"%" });
    if(bx.bottom < h)  add("crop-band", { top:(bx.bottom/h*100)+"%", height:((h-bx.bottom)/h*100)+"%" });
    if(bx.left > 0)    add("side-band", { left:"0%", width:(bx.left/w*100)+"%" });
    if(bx.right < w)   add("side-band", { left:(bx.right/w*100)+"%", width:((w-bx.right)/w*100)+"%" });

    state.cuts.forEach((c, idx) => {
      add("cut-line" + (c.manual?" manual":""), { top:(c.y/h*100)+"%" });
      const tag = add("cut-tag", { top:(c.y/h*100)+"%" });
      tag.textContent = (c.manual?"✎ ":"") + (idx+1) + " / " + (idx+2) + "p";
    });

    const edits = state.manualAdds.length + state.manualRemoves.length;
    els.clearManualBtn.hidden = edits === 0;
    els.manualCount.textContent = edits;
  }

  els.previewFrame.addEventListener("click", (e) => {
    if(!state.brightness) return;
    const rect = els.previewImg.getBoundingClientRect();
    if(rect.height <= 0) return;
    const y = Math.round((e.clientY - rect.top) / rect.height * state.natH);
    const bx = box();
    if(y <= bx.top || y >= bx.bottom) return;
    const tol = Math.max(20, state.natH*0.004);
    const hit = state.cuts.find(c => Math.abs(c.y-y) <= tol);
    if(hit){
      state.manualAdds = state.manualAdds.filter(a => Math.abs(a-hit.y) > tol);
      if(!hit.manual) state.manualRemoves.push(hit.y);
    }else{
      let snapped = y, bestD = Infinity;
      for(const b of state.blankBands){
        const d = Math.abs(b-y);
        if(d < bestD && d <= tol*4){ bestD = d; snapped = b; }
      }
      state.manualAdds.push(snapped);
      state.manualRemoves = state.manualRemoves.filter(r => Math.abs(r-snapped) > tol);
    }
    recompute();
  });
  els.clearManualBtn.addEventListener("click", () => {
    state.manualAdds=[]; state.manualRemoves=[]; recompute();
  });

  // ---------- results ----------
  function renderResults(bx){
    const pages = state.pages;
    els.results.hidden = pages.length === 0;
    if(!pages.length) return;

    els.statsBar.innerHTML = "";
    [["총 페이지", pages.length+"장"],
     ["페이지 크기", fmtInt(bx.width)+" × "+fmtInt(pages[0].height)+"px"],
     ["적용 비율", "1 : "+ratio().toFixed(3)],
     ["잘라낸 여백", fmtInt(state.natW-bx.width)+" × "+fmtInt(state.natH-bx.height)+"px"]
    ].forEach(([l,n])=>{
      const s=document.createElement("div"); s.className="stat";
      s.innerHTML = '<span class="n mono">'+n+'</span><span class="l">'+l+'</span>';
      els.statsBar.appendChild(s);
    });

    els.pageGrid.innerHTML = "";
    pages.forEach((p, idx) => {
      const card=document.createElement("div"); card.className="card page-card";
      const thumb=document.createElement("div"); thumb.className="page-thumb"; card.appendChild(thumb);
      const meta=document.createElement("div"); meta.className="page-meta";
      meta.innerHTML = '<span><span class="idx">'+String(idx+1).padStart(2,"0")+'페이지</span>'
        + '<span class="h mono">'+fmtInt(p.height)+'px</span></span>';
      const b=document.createElement("button"); b.className="icon-btn"; b.title="이 페이지 저장";
      b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';
      b.addEventListener("click", (e)=>{ e.stopPropagation(); downloadPage(idx); });
      meta.appendChild(b); card.appendChild(meta);
      thumb.style.cursor = "zoom-in";
      thumb.title = "이 페이지부터 읽기";
      thumb.addEventListener("click", ()=>openReader(idx));
      els.pageGrid.appendChild(card);
    });
    requestAnimationFrame(layoutThumbs);
  }

  function layoutThumbs(){
    const bx = box();
    els.pageGrid.querySelectorAll(".page-thumb").forEach((thumb, idx) => {
      const p = state.pages[idx]; if(!p) return;
      const width = thumb.getBoundingClientRect().width || 148;
      const scale = width / bx.width;
      thumb.style.height = Math.round(p.height*scale)+"px";
      thumb.style.backgroundImage = "url("+state.url+")";
      thumb.style.backgroundSize = Math.round(state.natW*scale)+"px "+Math.round(state.natH*scale)+"px";
      thumb.style.backgroundPosition = "-"+Math.round(bx.left*scale)+"px -"+Math.round(p.start*scale)+"px";
    });
  }
  window.addEventListener("resize", debounce(layoutThumbs, 200));

  // ---------- export ----------
  function pageToBlob(p){
    const bx = box();
    const c = document.createElement("canvas");
    c.width = bx.width; c.height = p.height;
    c.getContext("2d").drawImage(state.canvas, bx.left, p.start, bx.width, p.height, 0, 0, bx.width, p.height);
    return new Promise(res => switchGet(els.fmtToggle)
      ? c.toBlob(b=>res(b), "image/png")
      : c.toBlob(b=>res(b), "image/jpeg", 0.9));
  }
  function pageFilename(idx){
    const base = (els.baseName.value||"page").trim().replace(/[\\/:*?"<>|]/g,"_") || "page";
    return base + "_" + String(idx+1).padStart(2,"0") + "." + (switchGet(els.fmtToggle)?"png":"jpg");
  }
  function saveError(err, no){
    const code = err && err.code;
    if(code === "declined"){ toast("저장이 취소되어 멈췄어요."); return true; }
    if(code === "too_large"){ toast((no?no+"페이지 ":"")+"용량이 커서 건너뛰었어요. 고화질 PNG를 꺼보세요."); return false; }
    if(code === "rate_limited"){ toast("저장 요청이 밀렸어요. 잠시 후 이어서 시도해주세요."); return true; }
    toast("저장 중 문제가 발생했어요."); return true;
  }
  async function downloadPage(idx){
    const dl = await getDownloads();
    if(!dl){ toast("이 화면에서는 파일 저장을 사용할 수 없어요."); return; }
    try{ await dl.save({ filename:pageFilename(idx), data: await pageToBlob(state.pages[idx]) }); }
    catch(err){ saveError(err); }
  }
  // Minimal PDF writer. JPEG bytes go in verbatim via /DCTDecode, so no
  // external library is needed — the page must stay self-contained.

  function pageJpeg(p, quality, scale){
    const bx = box();
    const w = Math.max(1, Math.round(bx.width*scale));
    const h = Math.max(1, Math.round(p.height*scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,w,h);
    ctx.drawImage(state.canvas, bx.left, p.start, bx.width, p.height, 0, 0, w, h);
    return new Promise(res => c.toBlob(b => res({ blob:b, w, h }), "image/jpeg", quality));
  }

  const MAX_BYTES = 15.4*1024*1024;

  els.downloadPdfBtn.addEventListener("click", async () => {
    const dl = await getDownloads();
    if(!dl){ toast("이 화면에서는 파일 저장을 사용할 수 없어요."); return; }
    const btn = els.downloadPdfBtn;
    const label = btn.innerHTML;
    btn.disabled = true;
    try{
      // shrink only as far as needed to fit the save limit
      const tries = [[0.85,1],[0.75,1],[0.7,0.8],[0.6,0.65],[0.5,0.5]];
      let pdf = null;
      for(let t=0; t<tries.length; t++){
        const [q, sc] = tries[t];
        const items = [];
        for(let i=0;i<state.pages.length;i++){
          btn.textContent = "PDF 만드는 중… (" + (i+1) + "/" + state.pages.length + ")";
          const r = await pageJpeg(state.pages[i], q, sc);
          if(!r.blob) throw new Error("encode");
          items.push({ bytes:new Uint8Array(await r.blob.arrayBuffer()), w:r.w, h:r.h });
        }
        btn.textContent = "PDF 묶는 중…";
        pdf = buildPdf(items);
        if(pdf.length <= MAX_BYTES) break;
        if(t === tries.length-1){ toast("페이지가 너무 많아 PDF 한 파일로 담기 어려워요. 낱장 저장을 써주세요."); pdf = null; }
      }
      if(pdf){
        const base = (els.baseName.value||"comic").trim().replace(/[\\/:*?"<>|]/g,"_") || "comic";
        await dl.save({ filename: base + ".pdf", data: pdf });
      }
    }catch(err){
      if(err && err.code === "extension_not_enabled"){
        toast("이 화면에서는 PDF 저장이 막혀 있어요. 낱장 이미지로 저장해주세요.");
      }else if(err && err.code === "declined"){
        // user said no; nothing to report
      }else{
        saveError(err);
      }
    }finally{
      btn.disabled = false;
      btn.innerHTML = label;
    }
  });

  els.downloadAllBtn.addEventListener("click", async () => {
    const dl = await getDownloads();
    if(!dl){ toast("이 화면에서는 파일 저장을 사용할 수 없어요."); return; }
    els.downloadAllBtn.disabled = true;
    const total = state.pages.length;
    let stop = false;
    for(let i=0;i<total && !stop;i++){
      els.downloadAllBtn.textContent = "저장 중… ("+(i+1)+"/"+total+")";
      const blob = await pageToBlob(state.pages[i]);
      // the host throttles bursts of save prompts — back off and retry rather
      // than giving up, which is what dropped every page past the fifth
      for(let attempt=0; attempt<6; attempt++){
        try{ await dl.save({ filename:pageFilename(i), data: blob }); break; }
        catch(err){
          if(err && err.code === "rate_limited"){
            els.downloadAllBtn.textContent = "잠시 대기 중… ("+(i+1)+"/"+total+")";
            await new Promise(r=>setTimeout(r, 900*(attempt+1)));
            continue;
          }
          if(saveError(err, i+1)) stop = true;
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
  els.customRatio.addEventListener("input", () => { state.userPageCount=null; debouncedRecompute(); });
  [els.cropLeft, els.cropRight, els.cropTop, els.cropBottom].forEach(el =>
    el.addEventListener("input", () => { state.userPageCount=null; debouncedRecompute(); }));
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

  // ---------- reader ----------
  const R = {
    root:$("#reader"), stage:$("#rStage"), cv:$("#rCanvas"),
    count:$("#rCount"), title:$("#rTitle"), bar:$("#rBar"), hint:$("#rHint"),
    close:$("#rClose"), dir:$("#rDir"), fit:$("#rFit"),
    spread:$("#rSpread"), cover:$("#rCover"),
    zoneL:$("#rZoneL"), zoneR:$("#rZoneR")
  };
  const viewer = { open:false, idx:0, fit:"page", rtl:true,
                   spread:"single", spreadAuto:true, coverAlone:true };

  function bookmarkKey(){
    return "manhwa-reader:" + ((state.file && state.file.name) || "untitled");
  }
  function saveBookmark(){
    try{ localStorage.setItem(bookmarkKey(), String(viewer.idx)); }catch(e){}
  }
  function loadBookmark(){
    try{
      const v = parseInt(localStorage.getItem(bookmarkKey()), 10);
      return Number.isFinite(v) ? v : 0;
    }catch(e){ return 0; }
  }
  function loadReaderPrefs(){
    try{
      const v = JSON.parse(localStorage.getItem("manhwa-reader-prefs")||"null");
      if(v){
        if(typeof v.rtl === "boolean") viewer.rtl = v.rtl;
        if(v.fit) viewer.fit = v.fit;
        if(v.spread){ viewer.spread = v.spread; viewer.spreadAuto = false; }
        if(typeof v.coverAlone === "boolean") viewer.coverAlone = v.coverAlone;
      }
    }catch(e){}
  }
  function saveReaderPrefs(){
    try{ localStorage.setItem("manhwa-reader-prefs",
      JSON.stringify({ rtl:viewer.rtl, fit:viewer.fit,
        spread:viewer.spread, coverAlone:viewer.coverAlone })); }catch(e){}
  }

  // Which pages sit in the current view, in ascending page order.
  // A printed comic opens on a single cover, then runs in pairs.
  function pagesAt(idx){
    const n = state.pages.length;
    idx = clamp(idx, 0, n-1);
    if(viewer.spread !== "double") return [idx];
    if(viewer.coverAlone && idx === 0) return [0];
    const off = viewer.coverAlone ? 1 : 0;
    const a = idx - ((idx - off) % 2);
    const b = a + 1;
    return b < n ? [a, b] : [a];
  }

  const GAP = 10;   // hairline between the two leaves

  function drawPage(){
    if(!state.canvas || !state.pages.length) return;
    const bx = box();
    const idxs = pagesAt(viewer.idx);
    const leaves = idxs.map(i => state.pages[i]).filter(Boolean);
    if(!leaves.length) return;
    // right-to-left reading puts the LOWER page number on the right
    const order = viewer.rtl ? leaves.slice().reverse() : leaves;

    const availW = R.stage.clientWidth, availH = R.stage.clientHeight;
    if(availW <= 0) return;
    const gap = order.length > 1 ? GAP : 0;
    const srcW = bx.width*order.length + gap;
    const srcH = Math.max.apply(null, order.map(p => p.height));
    if(srcW <= 0 || srcH <= 0) return;

    const scale = viewer.fit === "width" ? availW/srcW : Math.min(availW/srcW, availH/srcH);
    const dw = Math.max(1, Math.round(srcW*scale));
    const dh = Math.max(1, Math.round(srcH*scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    R.cv.style.width = dw + "px";
    R.cv.style.height = dh + "px";
    R.cv.width = Math.round(dw*dpr);
    R.cv.height = Math.round(dh*dpr);
    const ctx = R.cv.getContext("2d");
    ctx.setTransform(dpr*scale, 0, 0, dpr*scale, 0, 0);   // draw in source units
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, srcW, srcH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    let x = 0;
    for(const p of order){
      const y = (srcH - p.height)/2;                       // centre unequal leaves
      ctx.drawImage(state.canvas, bx.left, p.start, bx.width, p.height,
                    x, y, bx.width, p.height);
      x += bx.width + gap;
    }
    R.stage.scrollTop = 0;

    const n = state.pages.length;
    R.count.textContent = (idxs.length > 1
      ? (idxs[0]+1) + "–" + (idxs[idxs.length-1]+1)
      : String(idxs[0]+1)) + " / " + n;
    R.bar.style.width = (n > 1 ? (idxs[idxs.length-1]/(n-1))*100 : 100) + "%";
  }

  function go(dir){
    const n = state.pages.length;
    const cur = pagesAt(viewer.idx);
    let next;
    if(dir > 0){
      next = cur[cur.length-1] + 1;
      if(next > n-1) return;
    }else{
      if(cur[0] <= 0) return;
      next = pagesAt(cur[0]-1)[0];
    }
    viewer.idx = clamp(next, 0, n-1);
    saveBookmark();
    drawPage();
  }

  function openReader(idx){
    if(!state.pages.length) return;
    viewer.open = true;
    viewer.idx = clamp(idx != null ? idx : loadBookmark(), 0, state.pages.length-1);
    R.root.hidden = false;
    document.body.style.overflow = "hidden";
    R.title.textContent = (state.file && state.file.name) || "";
    if(viewer.spreadAuto){
      // a landscape window has room for two leaves; a phone held upright does not
      const w = window.innerWidth, h = window.innerHeight;
      viewer.spread = (w/h > 1.15 && w >= 900) ? "double" : "single";
    }
    viewer.idx = pagesAt(viewer.idx)[0];
    syncReaderButtons();
    requestAnimationFrame(() => {
      drawPage();
      R.hint.style.opacity = "1";
      setTimeout(() => { R.hint.style.opacity = "0"; }, 2600);
    });
  }
  function closeReader(){
    viewer.open = false;
    R.root.hidden = true;
    document.body.style.overflow = "";
  }
  function syncReaderButtons(){
    R.dir.textContent = viewer.rtl ? "오른쪽 → 왼쪽" : "왼쪽 → 오른쪽";
    R.fit.textContent = viewer.fit === "width" ? "폭 맞춤" : "화면 맞춤";
    R.fit.setAttribute("aria-pressed", viewer.fit === "page" ? "true" : "false");
    const dbl = viewer.spread === "double";
    R.spread.textContent = dbl ? "두 쪽" : "한 쪽";
    R.spread.setAttribute("aria-pressed", dbl ? "true" : "false");
    R.cover.hidden = !dbl;
    R.cover.textContent = viewer.coverAlone ? "표지 단독" : "표지 나란히";
    R.cover.setAttribute("aria-pressed", viewer.coverAlone ? "true" : "false");
  }

  R.close.addEventListener("click", closeReader);
  R.spread.addEventListener("click", () => {
    viewer.spread = viewer.spread === "double" ? "single" : "double";
    viewer.spreadAuto = false;               // an explicit choice sticks
    viewer.idx = pagesAt(viewer.idx)[0];
    syncReaderButtons(); saveReaderPrefs(); drawPage();
  });
  R.cover.addEventListener("click", () => {
    viewer.coverAlone = !viewer.coverAlone;
    viewer.idx = pagesAt(viewer.idx)[0];
    syncReaderButtons(); saveReaderPrefs(); drawPage();
  });
  R.dir.addEventListener("click", () => { viewer.rtl = !viewer.rtl; syncReaderButtons(); saveReaderPrefs(); });
  R.fit.addEventListener("click", () => {
    viewer.fit = viewer.fit === "page" ? "width" : "page";
    syncReaderButtons(); saveReaderPrefs(); drawPage();
  });
  // In right-to-left reading the LEFT side advances, as in a printed comic.
  R.zoneL.addEventListener("click", () => go(viewer.rtl ? 1 : -1));
  R.zoneR.addEventListener("click", () => go(viewer.rtl ? -1 : 1));

  document.addEventListener("keydown", (e) => {
    if(!viewer.open) return;
    if(e.key === "Escape"){ closeReader(); return; }
    if(e.key === "ArrowLeft"){ e.preventDefault(); go(viewer.rtl ? 1 : -1); }
    else if(e.key === "ArrowRight"){ e.preventDefault(); go(viewer.rtl ? -1 : 1); }
    else if(e.key === "ArrowDown" || e.key === "PageDown" || e.key === " "){ e.preventDefault(); go(1); }
    else if(e.key === "ArrowUp" || e.key === "PageUp"){ e.preventDefault(); go(-1); }
    else if(e.key === "Home"){ e.preventDefault(); viewer.idx = 0; saveBookmark(); drawPage(); }
    else if(e.key === "End"){
      e.preventDefault();
      viewer.idx = pagesAt(state.pages.length-1)[0];
      saveBookmark(); drawPage();
    }
    else if(e.key === "d" || e.key === "D"){ e.preventDefault(); R.spread.click(); }
  });

  let touchX = null, touchY = null;
  R.stage.addEventListener("touchstart", (e) => {
    if(e.touches.length !== 1) return;
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive:true });
  R.stage.addEventListener("touchend", (e) => {
    if(touchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = null;
    if(Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)){
      // swiping left moves forward when reading right-to-left
      go(dx < 0 ? (viewer.rtl ? -1 : 1) : (viewer.rtl ? 1 : -1));
    }
  }, { passive:true });

  window.addEventListener("resize", debounce(() => { if(viewer.open) drawPage(); }, 150));
  els.readBtn.addEventListener("click", () => openReader(null));

  loadSettings();
  loadReaderPrefs();
  els.customRatioWrap.hidden = els.ratioSel.value !== "custom";

}
