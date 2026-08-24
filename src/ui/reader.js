/**
 * The comic reader.
 *
 * It knows nothing about where pages come from — see ./sources.js. Hand it a
 * page source and it reads: one leaf or a spread, left-to-right or right-to-
 * left, turning like paper, with pins, zoom, a page list and a continuous
 * scrolling mode for a phone.
 *
 * Three things shape this file.
 *
 *   Pages arrive asynchronously, so every render is awaited and carries a
 *   token; a fast reader outruns the decoder and a stale render must not paint
 *   over a newer one.
 *
 *   Every state change queues. Turning, toggling a spread, changing chapter and
 *   resizing all run one at a time, because two of them interleaved leave the
 *   canvas and the page counter describing different places.
 *
 *   Pages are not all the same size, so leaves are normalised to a common
 *   height before being laid side by side rather than assuming one width.
 */
import { clamp } from "../core/geometry.js";
import { settleTarget } from "../core/curl.js";
import {
  isPinned, togglePin, removePin, groupPins, countPins
} from "../core/bookmarks.js";
import { drawCurl } from "./curl.js";

const GAP = 10;              // hairline between two leaves
const TURN_MS = 520;
const TAP_SLOP = 12;         // movement below this is a tap, not a drag
const MAX_ZOOM = 5;
const CHROME_IDLE = 2600;

export function createReader(root, hooks = {}) {
  const $ = (s) => root.querySelector(s);

  const R = {
    root,
    stage: $("#rStage"), book: $("#rBook"), cv: $("#rCanvas"),
    scroll: $("#rScroll"),
    count: $("#rCount"), title: $("#rTitle"), sub: $("#rSub"),
    bar: $("#rBar"), hint: $("#rHint"), busy: $("#rBusy"),
    topBar: $("#rTopBar"), foot: $("#rFoot"),
    slider: $("#rSlider"), footFrom: $("#rFootFrom"), footTo: $("#rFootTo"),
    close: $("#rClose"), dir: $("#rDir"), fit: $("#rFit"),
    spread: $("#rSpread"), cover: $("#rCover"), anim: $("#rAnim"), mode: $("#rMode"),
    settings: $("#rSettings"), settingsPanel: $("#rSettingsPanel"),
    full: $("#rFull"),
    pin: $("#rPin"), pinCount: $("#rPinCount"),
    pinListBtn: $("#rPinList"), pinPanel: $("#rPinPanel"),
    pinRows: $("#rPinList2"), pinEmpty: $("#rPinEmpty"), pinClose: $("#rPinClose"),
    splitRow: $("#rSplitRow"), splitN: $("#rSplitN"), splitNote: $("#rSplitNote"),
    splitDown: $("#rSplitDown"), splitUp: $("#rSplitUp"), splitAuto: $("#rSplitAuto"),
    thumbBtn: $("#rThumbBtn"), thumbs: $("#rThumbs"),
    thumbGrid: $("#rThumbGrid"), thumbClose: $("#rThumbClose")
  };

  const view = {
    open: false, idx: 0, source: null,
    fit: "page", rtl: true,
    spread: "single", spreadAuto: true, coverAlone: true,
    animate: true, mode: "book"
  };
  const zoom = { scale: 1, tx: 0, ty: 0 };

  let token = 0;             // guards against a stale async render landing late
  let rolling = false;       // a chapter change is under way
  let geo = null;            // the current render's on-screen size
  let pins = loadPins();

  // ---------- the queue ----------
  /**
   * Navigation runs one step at a time. A step with others waiting behind it
   * skips its animation, so a burst of taps stays immediate instead of playing
   * out a second of turns after the reader has stopped.
   */
  let chain = Promise.resolve();
  let queued = 0;
  function enqueue(fn) {
    queued++;
    chain = chain
      .then(fn)
      .catch((err) => { console.error("페이지 이동 실패", err); })
      .then(() => { queued--; });
    return chain;
  }

  // ---------- preferences ----------
  function loadPrefs() {
    try {
      const v = JSON.parse(localStorage.getItem("manhwa-reader-prefs") || "null");
      if (!v) return;
      if (typeof v.rtl === "boolean") view.rtl = v.rtl;
      if (v.fit) view.fit = v.fit;
      if (v.spread) { view.spread = v.spread; view.spreadAuto = false; }
      if (typeof v.coverAlone === "boolean") view.coverAlone = v.coverAlone;
      if (typeof v.animate === "boolean") view.animate = v.animate;
      if (v.mode) view.mode = v.mode;
    } catch (e) {}
  }
  function savePrefs() {
    try {
      localStorage.setItem("manhwa-reader-prefs", JSON.stringify({
        rtl: view.rtl, fit: view.fit, spread: view.spread,
        coverAlone: view.coverAlone, animate: view.animate, mode: view.mode
      }));
    } catch (e) {}
  }
  function loadPins() {
    try { return JSON.parse(localStorage.getItem("manhwa-pins") || "{}"); } catch (e) { return {}; }
  }
  function savePins() {
    try { localStorage.setItem("manhwa-pins", JSON.stringify(pins)); } catch (e) {}
  }
  const markKey = () => "manhwa-reader:" + (view.source ? view.source.id : "untitled");
  function saveMark() {
    try { localStorage.setItem(markKey(), String(view.idx)); } catch (e) {}
    if (hooks.onProgress && view.source) hooks.onProgress(view.source, view.idx);
  }
  function loadMark(source) {
    try {
      const v = parseInt(localStorage.getItem("manhwa-reader:" + source.id), 10);
      return Number.isFinite(v) ? v : 0;
    } catch (e) { return 0; }
  }

  // ---------- which pages are on screen ----------
  // A printed comic opens on a single cover, then runs in pairs.
  function pagesAt(i) {
    const n = view.source ? view.source.count : 0;
    if (!n) return [];
    i = clamp(i, 0, n - 1);
    if (view.spread !== "double" || view.mode === "scroll") return [i];
    if (view.coverAlone && i === 0) return [0];
    const off = view.coverAlone ? 1 : 0;
    const a = i - ((i - off) % 2);
    return a + 1 < n ? [a, a + 1] : [a];
  }

  // ---------- rendering ----------
  /**
   * Lay the leaves out and paint them. Leaves are scaled to a shared height so a
   * spread of two differently sized scans still meets at the spine.
   */
  function layout(leaves) {
    const order = view.rtl ? leaves.slice().reverse() : leaves;
    const H = Math.max.apply(null, order.map((p) => p.sh));
    const boxes = order.map((p) => ({ page: p, w: p.sw * (H / p.sh), h: H }));
    const gap = boxes.length > 1 ? GAP : 0;
    const srcW = boxes.reduce((s, b) => s + b.w, 0) + gap * (boxes.length - 1);
    if (srcW <= 0 || H <= 0) return null;

    const availW = R.stage.clientWidth, availH = R.stage.clientHeight;
    if (availW <= 0) return null;
    const scale = view.fit === "width" ? availW / srcW : Math.min(availW / srcW, availH / H);
    return {
      boxes, gap, srcW, srcH: H, scale,
      dw: Math.max(1, Math.round(srcW * scale)),
      dh: Math.max(1, Math.round(H * scale)),
      leaves: boxes.length
    };
  }

  /** Backing pixels per CSS pixel — raised while zoomed so text stays crisp. */
  function backing() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.min(4, dpr * Math.max(1, Math.min(zoom.scale, 3)));
  }

  function paint(canvas, L, ratio) {
    canvas.width = Math.round(L.dw * ratio);
    canvas.height = Math.round(L.dh * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio * L.scale, 0, 0, ratio * L.scale, 0, 0);  // source units
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, L.srcW, L.srcH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    let x = 0;
    for (const b of L.boxes) {
      const p = b.page;
      ctx.drawImage(p.img, p.sx, p.sy, p.sw, p.sh, x, 0, b.w, b.h);
      x += b.w + L.gap;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx;
  }

  async function fetchLeaves(idxs) {
    const out = [];
    for (const i of idxs) {
      const p = await view.source.getPage(i);
      if (p) out.push(p);
    }
    return out;
  }

  /** Paint the current index. Returns the geometry, or null if superseded. */
  async function render() {
    if (!view.source || !view.source.count) return null;
    if (view.mode === "scroll") return renderScroll();
    const mine = ++token;
    const idxs = pagesAt(view.idx);

    const slow = setTimeout(() => { if (mine === token) R.busy.hidden = false; }, 180);
    let leaves;
    try { leaves = await fetchLeaves(idxs); }
    finally { clearTimeout(slow); }
    if (mine !== token) return null;
    R.busy.hidden = true;
    if (!leaves.length) return null;

    const L = layout(leaves);
    if (!L) return null;
    paint(R.cv, L, backing());
    R.cv.style.width = L.dw + "px";
    R.cv.style.height = L.dh + "px";
    R.book.style.width = L.dw + "px";
    R.book.style.height = L.dh + "px";
    geo = L;
    // labels move with the pixels: a name updated anywhere else can announce a
    // page that is not on screen, or one a superseded render never brought
    setTitle();
    showCount(idxs);
    return L;
  }

  function showCount(idxs) {
    const n = view.source.count;
    const label = idxs.length > 1
      ? (idxs[0] + 1) + "–" + (idxs[idxs.length - 1] + 1)
      : String(idxs[0] + 1);
    R.count.textContent = label + " / " + n;
    R.bar.style.width = (n > 1 ? (idxs[idxs.length - 1] / (n - 1)) * 100 : 100) + "%";
    R.slider.max = String(Math.max(0, n - 1));
    R.slider.value = String(idxs[0]);
    R.footFrom.textContent = String(idxs[0] + 1);
    R.footTo.textContent = String(n);
    syncPinButton();
    markThumb();
  }

  // ---------- the page turn ----------
  /**
   * Turning is composited into the one canvas rather than layered in the DOM,
   * because the far half has to keep showing the OLD page until the sheet lands
   * on it. The destination render already holds the finished spread, so without
   * that the arriving page appears while the sheet is still in mid-air.
   */
  const turn = { active: false, before: null, after: null, leftward: true, progress: 0, forward: true };

  function snapshot(L) {
    const c = document.createElement("canvas");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    paint(c, L, ratio);
    c._cssW = L.dw;
    return c;
  }

  /** Render the view at `idx` off-screen, without disturbing what is displayed. */
  async function offscreen(idx) {
    const keep = view.idx;
    view.idx = idx;
    const idxs = pagesAt(idx);
    view.idx = keep;
    const leaves = await fetchLeaves(idxs);
    if (!leaves.length) return null;
    const L = layout(leaves);
    if (!L) return null;
    const c = document.createElement("canvas");
    paint(c, L, Math.min(2, window.devicePixelRatio || 1));
    c._cssW = L.dw;
    return { canvas: c, layout: L };
  }

  /** Paint one frame of a turn: base underneath, curling sheet on top. */
  function drawTurnFrame(progress) {
    const L = turn.after.layout;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    R.cv.width = Math.round(L.dw * ratio);
    R.cv.height = Math.round(L.dh * ratio);
    R.cv.style.width = L.dw + "px";
    R.cv.style.height = L.dh + "px";
    R.book.style.width = L.dw + "px";
    R.book.style.height = L.dh + "px";

    const ctx = R.cv.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#0d0d0f";
    ctx.fillRect(0, 0, L.dw, L.dh);

    const double = L.leaves > 1 && turn.before.layout.leaves > 1;
    const half = double ? L.dw / 2 : L.dw;
    const leafLeft = turn.leftward ? 0 : L.dw - half;
    const farLeft = L.dw - half - leafLeft;

    // base: the half being uncovered comes from the destination, the half the
    // sheet is about to land on keeps the old page until it does
    ctx.drawImage(turn.after.canvas,
      leafLeft * ratio, 0, half * ratio, turn.after.canvas.height,
      leafLeft, 0, half, L.dh);
    if (double) {
      const b = turn.before;
      const bHalf = b.canvas._cssW / 2;
      const bRatio = b.canvas.width / b.canvas._cssW;
      ctx.drawImage(b.canvas,
        (turn.leftward ? bHalf : 0) * bRatio, 0, bHalf * bRatio, b.canvas.height,
        farLeft, 0, half, L.dh);
    }

    const spineX = turn.leftward ? leafLeft + half : leafLeft;
    // source rectangles in each canvas's own backing pixels: the two renders can
    // differ in size, and the sheet is only half of each of them in a spread
    const bc = turn.before.canvas, ac = turn.after.canvas;
    const bScale = bc.width / bc._cssW, aScale = ac.width / ac._cssW;
    const bHalf = double ? bc._cssW / 2 : bc._cssW;
    drawCurl(ctx, {
      progress, leftward: turn.leftward,
      spineX, width: half, height: L.dh, top: 0,
      front: {
        img: bc, sh: bc.height,
        sx: (turn.leftward ? 0 : bc._cssW - bHalf) * bScale,
        sw: bHalf * bScale
      },
      back: {
        img: ac, sh: ac.height,
        sx: farLeft * aScale,
        sw: half * aScale
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wantsTurn = () => view.animate && !reduceMotion() && view.mode === "book" && queued <= 1;

  /**
   * A cover standing alone becomes a spread of two.
   *
   * Across that change the sheet has no honest size and the spine has no honest
   * place — the leaf that turns is half of one view and all of the other. Sized
   * to either it flies off the canvas or smears, so that one transition cuts.
   */
  const sameShape = (a, b) => pagesAt(a).length === pagesAt(b).length;

  /** Run a turn from `progress` to `to`, then settle on the destination. */
  function animateTurn(from, to) {
    return new Promise((done) => {
      const span = Math.abs(to - from) || 1;
      const ms = TURN_MS * span;
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        // decelerating: paper carries momentum into the turn and settles softly
        const e = 1 - Math.pow(1 - k, 3);
        drawTurnFrame(from + (to - from) * e);
        if (k < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  }

  async function goTo(next, forward) {
    const target = clamp(next, 0, view.source.count - 1);
    if (!wantsTurn() || !geo || !sameShape(view.idx, target)) {
      view.idx = target;
      saveMark();
      await render();
      return;
    }
    const before = { canvas: snapshot(geo), layout: geo };
    const after = await offscreen(target);
    if (!after) { view.idx = target; saveMark(); await render(); return; }

    turn.before = before;
    turn.after = after;
    turn.leftward = forward === view.rtl;
    await animateTurn(0, 1);
    view.idx = target;
    saveMark();
    await render();
  }

  /** Step one view forward or back, rolling into the next chapter at the ends. */
  async function go(dir) {
    if (!view.source || rolling) return;
    const n = view.source.count;
    const cur = pagesAt(view.idx);
    if (dir > 0) {
      const next = cur[cur.length - 1] + 1;
      if (next > n - 1) return rollChapter(1);
      await goTo(next, true);
    } else {
      if (cur[0] <= 0) return rollChapter(-1);
      await goTo(pagesAt(cur[0] - 1)[0], false);
    }
  }

  async function rollChapter(dir) {
    const src = view.source;
    const step = dir > 0 ? src.nextChapter : src.prevChapter;
    if (!step) { flash(dir > 0 ? "마지막 페이지예요." : "첫 페이지예요."); return; }
    rolling = true;
    R.busy.hidden = false;
    let nextSrc = null;
    try { nextSrc = await step(); } catch (e) {}
    R.busy.hidden = true;
    if (!nextSrc) { rolling = false; flash(dir > 0 ? "마지막 화예요." : "첫 화예요."); return; }
    src.release();
    view.source = nextSrc;
    view.idx = dir > 0 ? 0 : pagesAt(nextSrc.count - 1)[0];
    resetZoom();
    saveMark();
    flash(nextSrc.title);
    thumbsDirty = true;
    try { await render(); } finally { rolling = false; }
    if (!R.thumbs.hidden) buildThumbs();
  }

  let flashTimer = null;
  function flash(msg) {
    R.hint.textContent = msg;
    R.hint.style.opacity = "1";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { R.hint.style.opacity = "0"; }, 1800);
  }

  // ---------- zoom and pan ----------
  function applyZoom() {
    R.book.style.transform =
      "translate(" + zoom.tx + "px," + zoom.ty + "px) scale(" + zoom.scale + ")";
    R.stage.classList.toggle("zoomed", zoom.scale > 1.01);
  }
  function resetZoom() {
    zoom.scale = 1; zoom.tx = 0; zoom.ty = 0;
    applyZoom();
  }
  /** Keep the page overlapping the stage, so it can never be lost off-screen. */
  function clampPan() {
    if (!geo) return;
    const w = geo.dw * zoom.scale, h = geo.dh * zoom.scale;
    const sw = R.stage.clientWidth, sh = R.stage.clientHeight;
    const slackX = Math.max(0, (w - sw) / 2) + 40;
    const slackY = Math.max(0, (h - sh) / 2) + 40;
    zoom.tx = clamp(zoom.tx, -slackX, slackX);
    zoom.ty = clamp(zoom.ty, -slackY, slackY);
  }
  function zoomAt(scale, px, py) {
    const next = clamp(scale, 1, MAX_ZOOM);
    const r = R.book.getBoundingClientRect();
    const cx = px - (r.left + r.width / 2);
    const cy = py - (r.top + r.height / 2);
    const k = next / zoom.scale;
    zoom.tx = zoom.tx * k + cx * (1 - k);
    zoom.ty = zoom.ty * k + cy * (1 - k);
    zoom.scale = next;
    if (next <= 1.001) { zoom.tx = 0; zoom.ty = 0; }
    clampPan();
    applyZoom();
    sharpen();
  }
  let sharpenTimer = null;
  function sharpen() {
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(() => { if (view.open && !turn.active) enqueue(() => render()); }, 220);
  }

  // ---------- chrome ----------
  let chromeTimer = null;
  function showChrome(sticky) {
    R.root.classList.remove("immersive");
    clearTimeout(chromeTimer);
    if (!sticky) chromeTimer = setTimeout(hideChrome, CHROME_IDLE);
  }
  function hideChrome() {
    if (!R.settingsPanel.hidden || !R.thumbs.hidden || !R.pinPanel.hidden) return;
    R.root.classList.add("immersive");
  }
  function toggleChrome() {
    if (R.root.classList.contains("immersive")) showChrome(true);
    else hideChrome();
  }

  // ---------- pointer: tap, drag-turn, pinch ----------
  const pointers = new Map();
  let gesture = null;

  function stagePoint(e) {
    const r = R.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }

  R.stage.addEventListener("pointerdown", (e) => {
    if (view.mode === "scroll") return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    R.stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), s0: zoom.scale };
      return;
    }
    const p = stagePoint(e);
    gesture = {
      kind: "down", x0: e.clientX, y0: e.clientY, p,
      tx0: zoom.tx, ty0: zoom.ty, t0: performance.now(), moved: false
    };
  });

  R.stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.kind === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(gesture.s0 * (d / gesture.d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (gesture.kind === "pinch") return;

    const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
    if (!gesture.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    gesture.moved = true;

    if (zoom.scale > 1.01) {                       // zoomed in: the drag pans
      zoom.tx = gesture.tx0 + dx;
      zoom.ty = gesture.ty0 + dy;
      clampPan(); applyZoom();
      return;
    }
    if (Math.abs(dy) > Math.abs(dx) * 1.4) return; // a vertical drag is not a turn
    if (gesture.kind === "down") startDragTurn(dx);
    if (gesture.kind === "turn") updateDragTurn(dx);
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    try { R.stage.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!gesture) return;
    if (gesture.kind === "pinch") { gesture = pointers.size ? null : null; return; }
    if (gesture.kind === "turn") { finishDragTurn(e); return; }
    if (!gesture.moved) handleTap(gesture.p);
    gesture = null;
  };
  R.stage.addEventListener("pointerup", endPointer);
  R.stage.addEventListener("pointercancel", endPointer);

  /**
   * A tap near either edge turns; a tap in the middle clears the chrome away.
   * The middle is generous, because on a phone the thing people most want from
   * a tap is to see the page without anything on top of it.
   */
  function handleTap(p) {
    closePanels();
    const edge = p.w * 0.32;
    if (p.x < edge) step(view.rtl ? 1 : -1);
    else if (p.x > p.w - edge) step(view.rtl ? -1 : 1);
    else toggleChrome();
  }

  function turnDistance() {
    return Math.max(120, (geo ? geo.dw : R.stage.clientWidth) * 0.55);
  }

  function startDragTurn(dx) {
    if (!geo || !wantsTurn()) return;
    const forward = view.rtl ? dx < 0 : dx > 0;
    const cur = pagesAt(view.idx);
    const n = view.source.count;
    const target = forward ? cur[cur.length - 1] + 1 : (cur[0] > 0 ? pagesAt(cur[0] - 1)[0] : -1);
    if (target < 0 || target > n - 1) return;      // no neighbour to drag in
    if (!sameShape(view.idx, target)) return;      // cover to spread simply cuts

    gesture.kind = "turn";
    gesture.forward = forward;
    gesture.target = target;
    gesture.progress = 0;
    gesture.lastX = dx;
    gesture.lastT = performance.now();
    gesture.vel = 0;
    turn.active = true;
    turn.before = { canvas: snapshot(geo), layout: geo };
    turn.leftward = forward === view.rtl;
    turn.after = null;
    R.stage.classList.add("dragging");
    offscreen(target).then((after) => {
      if (gesture && gesture.kind === "turn") turn.after = after;
    });
  }

  function updateDragTurn(dx) {
    if (!turn.after) return;
    const p = clamp(Math.abs(dx) / turnDistance(), 0, 1);
    const now = performance.now();
    const dt = Math.max(16, now - gesture.lastT);
    gesture.vel = (p - gesture.progress) / (dt / 1000);
    gesture.progress = p;
    gesture.lastT = now;
    drawTurnFrame(p);
  }

  function finishDragTurn() {
    const g = gesture;
    gesture = null;
    R.stage.classList.remove("dragging");
    if (!turn.after) { turn.active = false; enqueue(() => render()); return; }
    const to = settleTarget(g.progress, g.vel);
    enqueue(async () => {
      await animateTurn(g.progress, to);
      turn.active = false;
      if (to === 1) { view.idx = g.target; saveMark(); }
      await render();
    });
  }

  // ---------- pins ----------
  function currentPin() {
    if (!view.source) return null;
    return {
      sourceId: view.source.id,
      page: pagesAt(view.idx)[0] || 0,
      series: view.source.seriesName || "",
      chapter: view.source.title || "",
      at: Date.now()
    };
  }
  function syncPinButton() {
    const p = currentPin();
    const on = p && isPinned(pins, p.sourceId, p.page);
    R.pin.setAttribute("aria-pressed", on ? "true" : "false");
    R.pin.title = on ? "핀 빼기 (P)" : "이 페이지 핀 (P)";
    R.pinCount.textContent = String(countPins(pins));
  }
  function doTogglePin() {
    const p = currentPin();
    if (!p) return;
    const was = isPinned(pins, p.sourceId, p.page);
    pins = togglePin(pins, p);
    savePins();
    syncPinButton();
    markThumb();
    if (!R.pinPanel.hidden) buildPins();
    flash(was ? "핀을 뺐어요." : "이 페이지를 핀했어요.");
  }

  function buildPins() {
    const groups = groupPins(pins);
    R.pinRows.innerHTML = "";
    R.pinEmpty.hidden = groups.length > 0;
    for (const g of groups) {
      const head = document.createElement("div");
      head.className = "pin-series";
      head.textContent = g.series || "이름 없는 시리즈";
      R.pinRows.appendChild(head);
      for (const p of g.pins) {
        const row = document.createElement("div");
        row.className = "pin-row";
        const go = document.createElement("button");
        go.className = "pin-row";
        go.style.padding = "0";
        go.innerHTML = '<span class="where"></span><span class="pg"></span>';
        go.querySelector(".where").textContent = p.chapter;
        go.querySelector(".pg").textContent = p.page + 1 + "쪽";
        go.addEventListener("click", () => jumpToPin(p));
        const drop = document.createElement("button");
        drop.className = "drop";
        drop.textContent = "빼기";
        drop.addEventListener("click", (e) => {
          e.stopPropagation();
          pins = removePin(pins, p.sourceId, p.page);
          savePins(); syncPinButton(); buildPins(); markThumb();
        });
        row.append(go, drop);
        R.pinRows.appendChild(row);
      }
    }
  }

  function jumpToPin(p) {
    closePanels();
    if (view.source && p.sourceId === view.source.id) {
      enqueue(async () => { view.idx = pagesAt(p.page)[0]; resetZoom(); saveMark(); await render(); });
      return;
    }
    if (hooks.onJump) hooks.onJump(p);
    else flash("그 화는 지금 열려 있지 않아요.");
  }

  // ---------- page list ----------
  let thumbsDirty = true;
  let thumbObserver = null;

  function buildThumbs() {
    if (!view.source) return;
    R.thumbGrid.innerHTML = "";
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        drawThumb(en.target);
        thumbObserver.unobserve(en.target);
      }
    }, { root: R.thumbGrid, rootMargin: "200px" });

    for (let i = 0; i < view.source.count; i++) {
      const b = document.createElement("button");
      b.className = "thumb";
      b.dataset.page = String(i);
      b.innerHTML = '<canvas></canvas><span class="n"></span>';
      b.querySelector(".n").textContent = String(i + 1);
      b.addEventListener("click", () => {
        closePanels();
        enqueue(async () => { view.idx = pagesAt(i)[0]; resetZoom(); saveMark(); await render(); });
      });
      R.thumbGrid.appendChild(b);
      thumbObserver.observe(b);
    }
    thumbsDirty = false;
    markThumb();
  }

  async function drawThumb(el) {
    const i = Number(el.dataset.page);
    const p = await view.source.getPage(i);
    if (!p) return;
    const cv = el.querySelector("canvas");
    const w = 84 * 2, h = Math.round(w * (p.sh / p.sw));
    cv.width = w; cv.height = h;
    cv.style.aspectRatio = p.sw + " / " + p.sh;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(p.img, p.sx, p.sy, p.sw, p.sh, 0, 0, w, h);
  }

  function markThumb() {
    if (!R.thumbGrid.children.length || !view.source) return;
    const here = pagesAt(view.idx);
    for (const el of R.thumbGrid.children) {
      const i = Number(el.dataset.page);
      el.classList.toggle("here", here.includes(i));
      const flagged = isPinned(pins, view.source.id, i);
      let flag = el.querySelector(".flag");
      if (flagged && !flag) {
        flag = document.createElement("span");
        flag.className = "flag";
        flag.textContent = "⚑";
        el.appendChild(flag);
      } else if (!flagged && flag) flag.remove();
    }
  }

  // ---------- continuous scrolling ----------
  let scrollObserver = null;
  async function renderScroll() {
    const mine = ++token;
    if (!R.scroll.dataset.for || R.scroll.dataset.for !== view.source.id) {
      R.scroll.innerHTML = "";
      R.scroll.dataset.for = view.source.id;
      if (scrollObserver) scrollObserver.disconnect();
      scrollObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.isIntersecting) drawSlot(en.target);
          else clearSlot(en.target);
          if (en.isIntersecting && en.intersectionRatio > 0.5) {
            const i = Number(en.target.dataset.page);
            if (i !== view.idx) { view.idx = i; saveMark(); showCount([i]); }
          }
        }
      }, { root: R.scroll, rootMargin: "150% 0px", threshold: [0, 0.51] });

      const width = Math.min(R.scroll.clientWidth, 900);
      for (let i = 0; i < view.source.count; i++) {
        const slot = document.createElement("canvas");
        slot.className = "scroll-slot";
        slot.dataset.page = String(i);
        slot.style.width = width + "px";
        slot.style.height = Math.round(width * 1.414) + "px";
        R.scroll.appendChild(slot);
        scrollObserver.observe(slot);
      }
    }
    if (mine !== token) return null;
    const target = R.scroll.querySelector('[data-page="' + view.idx + '"]');
    if (target) target.scrollIntoView({ block: "start" });
    showCount([view.idx]);
    setTitle();
    return null;
  }

  async function drawSlot(cv) {
    if (cv.dataset.drawn === "1") return;
    const i = Number(cv.dataset.page);
    const p = await view.source.getPage(i);
    if (!p) return;
    const width = Math.min(R.scroll.clientWidth, 900);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const h = Math.round(width * (p.sh / p.sw));
    cv.style.width = width + "px";
    cv.style.height = h + "px";
    cv.width = Math.round(width * ratio);
    cv.height = Math.round(h * ratio);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(p.img, p.sx, p.sy, p.sw, p.sh, 0, 0, cv.width, cv.height);
    cv.dataset.drawn = "1";
  }
  function clearSlot(cv) {
    if (cv.dataset.drawn !== "1") return;
    // a hundred decoded pages will not fit in a phone; let the far ones go
    cv.width = 1; cv.height = 1;
    cv.dataset.drawn = "0";
  }

  function applyMode() {
    const scroll = view.mode === "scroll";
    R.scroll.hidden = !scroll;
    R.book.hidden = scroll;
    R.mode.textContent = scroll ? "이어서 스크롤" : "책장 넘기기";
    R.spread.disabled = scroll;
    if (!scroll) { R.scroll.innerHTML = ""; R.scroll.dataset.for = ""; }
    else resetZoom();
  }

  // ---------- chrome sync ----------
  function setTitle() {
    const s = view.source;
    R.title.textContent = (s && s.seriesName) || "";
    R.sub.textContent = (s && s.title) || "";
  }
  function syncButtons() {
    R.dir.textContent = view.rtl ? "오른쪽 → 왼쪽" : "왼쪽 → 오른쪽";
    R.fit.textContent = view.fit === "width" ? "폭 맞춤" : "화면 맞춤";
    R.fit.setAttribute("aria-pressed", view.fit === "page" ? "true" : "false");
    const dbl = view.spread === "double";
    R.spread.textContent = dbl ? "두 쪽" : "한 쪽";
    R.spread.setAttribute("aria-pressed", dbl ? "true" : "false");
    R.cover.hidden = !dbl;
    R.cover.textContent = view.coverAlone ? "표지 단독" : "표지 나란히";
    R.cover.setAttribute("aria-pressed", view.coverAlone ? "true" : "false");
    const split = view.source && view.source.pageSplit;
    R.splitRow.hidden = !split;
    R.splitNote.hidden = !split;
    if (split) R.splitN.textContent = String(split.current);
    R.anim.textContent = view.animate ? "넘김 켜짐" : "넘김 꺼짐";
    R.anim.setAttribute("aria-pressed", view.animate ? "true" : "false");
    R.mode.textContent = view.mode === "scroll" ? "이어서 스크롤" : "책장 넘기기";
    syncPinButton();
  }

  function closePanels() {
    R.settingsPanel.hidden = true;
    R.settings.setAttribute("aria-expanded", "false");
    R.thumbs.hidden = true;
    R.pinPanel.hidden = true;
  }

  // ---------- screen ----------
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && "wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* a nice-to-have, never a requirement */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (view.open && document.visibilityState === "visible") keepAwake(true);
  });

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await R.root.requestFullscreen();
    } catch (e) { flash("전체화면을 쓸 수 없어요."); }
  }

  // ---------- open / close ----------
  async function open(source, startIndex) {
    if (!source || !source.count) return;
    if (view.source && view.source !== source) view.source.release();
    view.source = source;
    view.open = true;
    view.idx = clamp(startIndex != null ? startIndex : loadMark(source), 0, source.count - 1);
    R.root.hidden = false;
    document.body.style.overflow = "hidden";
    resetZoom();
    closePanels();
    thumbsDirty = true;
    setTitle();
    if (view.spreadAuto) {
      // a landscape window has room for two leaves; a phone held upright does not
      const w = window.innerWidth, h = window.innerHeight;
      view.spread = (w / h > 1.15 && w >= 900) ? "double" : "single";
    }
    view.idx = pagesAt(view.idx)[0];
    applyMode();
    syncButtons();
    showChrome(false);
    keepAwake(true);
    await new Promise((r) => requestAnimationFrame(r));
    await enqueue(() => render());
    flash("좌우를 누르거나 끌어서 넘기세요 · 가운데를 누르면 화면이 깔끔해져요");
  }

  function close() {
    view.open = false;
    token++;
    R.root.hidden = true;
    R.busy.hidden = true;
    closePanels();
    document.body.style.overflow = "";
    keepAwake(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    R.scroll.innerHTML = ""; R.scroll.dataset.for = "";
    if (view.source) view.source.release();
    // Through the queue: a turn still settling has not recorded its page yet,
    // and closing on top of it redrew the shelf from state one page behind —
    // a chapter read to the end came back marked as still being read.
    if (hooks.onClose) enqueue(async () => { hooks.onClose(); });
  }

  // ---------- wiring ----------
  const step = (dir) => enqueue(() => go(dir));

  R.close.addEventListener("click", close);
  R.spread.addEventListener("click", () => enqueue(async () => {
    view.spread = view.spread === "double" ? "single" : "double";
    view.spreadAuto = false;                    // an explicit choice sticks
    view.idx = pagesAt(view.idx)[0];
    syncButtons(); savePrefs(); await render();
  }));
  R.cover.addEventListener("click", () => enqueue(async () => {
    view.coverAlone = !view.coverAlone;
    view.idx = pagesAt(view.idx)[0];
    syncButtons(); savePrefs(); await render();
  }));
  R.dir.addEventListener("click", () => enqueue(async () => {
    view.rtl = !view.rtl; syncButtons(); savePrefs(); await render();
  }));
  R.fit.addEventListener("click", () => enqueue(async () => {
    view.fit = view.fit === "page" ? "width" : "page";
    resetZoom(); syncButtons(); savePrefs(); await render();
  }));
  R.anim.addEventListener("click", () => {
    view.animate = !view.animate; syncButtons(); savePrefs();
  });
  R.mode.addEventListener("click", () => enqueue(async () => {
    view.mode = view.mode === "scroll" ? "book" : "scroll";
    applyMode(); syncButtons(); savePrefs();
    await render();
  }));
  /**
   * Re-cut this chapter into a different number of pages.
   *
   * The reading position is kept in proportion rather than by index — asking for
   * more pages does not move the reader backwards through the same paper, which
   * is what jumping to the same page number would do.
   */
  function resplit(to) {
    const split = view.source && view.source.pageSplit;
    if (!split) return;
    enqueue(async () => {
      const before = Math.max(1, view.source.count);
      const at = view.idx / before;
      const pages = await split.set(to(split));
      view.source.setPages(pages);
      view.idx = pagesAt(clamp(Math.round(at * pages.length), 0, pages.length - 1))[0];
      resetZoom();
      thumbsDirty = true;
      saveMark();
      syncButtons();
      await render();
      if (!R.thumbs.hidden) buildThumbs();
      flash(pages.length + "쪽으로 나눴어요.");
    });
  }
  R.splitDown.addEventListener("click", () => resplit((s) => s.current - 1));
  R.splitUp.addEventListener("click", () => resplit((s) => s.current + 1));
  R.splitAuto.addEventListener("click", () => resplit((s) => s.auto));

  R.full.addEventListener("click", toggleFullscreen);
  R.pin.addEventListener("click", doTogglePin);

  R.settings.addEventListener("click", () => {
    const show = R.settingsPanel.hidden;
    closePanels();
    R.settingsPanel.hidden = !show;
    R.settings.setAttribute("aria-expanded", show ? "true" : "false");
    if (show) showChrome(true);
  });
  R.thumbBtn.addEventListener("click", () => {
    const show = R.thumbs.hidden;
    closePanels();
    R.thumbs.hidden = !show;
    if (show) { showChrome(true); if (thumbsDirty) buildThumbs(); else markThumb(); }
  });
  R.thumbClose.addEventListener("click", closePanels);
  R.pinListBtn.addEventListener("click", () => {
    const show = R.pinPanel.hidden;
    closePanels();
    R.pinPanel.hidden = !show;
    if (show) { showChrome(true); buildPins(); }
  });
  R.pinClose.addEventListener("click", closePanels);

  R.slider.addEventListener("input", () => {
    showChrome(true);
    const i = Number(R.slider.value);
    R.footFrom.textContent = String(i + 1);
  });
  R.slider.addEventListener("change", () => enqueue(async () => {
    view.idx = pagesAt(Number(R.slider.value))[0];
    resetZoom(); saveMark(); await render();
  }));

  R.stage.addEventListener("wheel", (e) => {
    if (view.mode === "scroll") return;
    e.preventDefault();
    if (e.ctrlKey || Math.abs(e.deltaY) < 40) {
      zoomAt(zoom.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
    } else if (zoom.scale <= 1.01) {
      step(e.deltaY > 0 ? 1 : -1);
    }
  }, { passive: false });

  R.stage.addEventListener("dblclick", (e) => {
    if (view.mode === "scroll") return;
    zoomAt(zoom.scale > 1.01 ? 1 : 2.4, e.clientX, e.clientY);
  });

  document.addEventListener("keydown", (e) => {
    if (!view.open) return;
    if (e.key === "Escape") {
      if (!R.settingsPanel.hidden || !R.thumbs.hidden || !R.pinPanel.hidden) { closePanels(); return; }
      close(); return;
    }
    const k = e.key.toLowerCase();
    if (e.key === "ArrowLeft") { e.preventDefault(); step(view.rtl ? 1 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(view.rtl ? -1 : 1); }
    else if (e.key === "PageDown" || e.key === " ") { e.preventDefault(); step(1); }
    else if (e.key === "PageUp") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowDown" && view.mode === "book") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" && view.mode === "book") { e.preventDefault(); step(-1); }
    else if (e.key === "Home") { e.preventDefault(); enqueue(() => goTo(0, false)); }
    else if (e.key === "End") { e.preventDefault(); enqueue(() => goTo(pagesAt(view.source.count - 1)[0], true)); }
    else if (k === "d") { e.preventDefault(); R.spread.click(); }
    else if (k === "p") { e.preventDefault(); doTogglePin(); }
    else if (k === "b") { e.preventDefault(); R.pinListBtn.click(); }
    else if (k === "t") { e.preventDefault(); R.thumbBtn.click(); }
    else if (k === "f") { e.preventDefault(); toggleFullscreen(); }
    else if (k === "0") { e.preventDefault(); resetZoom(); sharpen(); }
  });

  /**
   * A nudge of the mouse brings the chrome back — but it has to be a real nudge.
   *
   * A click reports a mousemove at the same spot, so reacting to every move let
   * that phantom reveal the chrome a moment before the tap arrived. The tap then
   * saw it visible and hid it again, which made tapping the middle a one-way
   * trip: it could hide the chrome but never bring it back.
   */
  let mouseAt = null;
  R.stage.addEventListener("mousemove", (e) => {
    if (!view.open) return;
    const moved = !mouseAt || Math.hypot(e.clientX - mouseAt.x, e.clientY - mouseAt.y) > 8;
    mouseAt = { x: e.clientX, y: e.clientY };
    if (moved) showChrome(false);
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    // through the queue like everything else: a re-layout landing mid-turn
    // cancels that turn's render and strands its page counter
    resizeTimer = setTimeout(() => { if (view.open) { resetZoom(); enqueue(() => render()); } }, 150);
  });

  loadPrefs();
  syncButtons();

  return { open, close, view };
}
