/**
 * The comic reader.
 *
 * It knows nothing about where pages come from — see ./sources.js. Hand it a
 * page source and it reads: one leaf or a spread, left-to-right or right-to-
 * left, turning with a hinge at the spine.
 *
 * Two things drive the shape of this file:
 *
 *   Pages arrive asynchronously. A folder source has to decode a file before it
 *   can be drawn, so every render is awaited and carries a token — a fast reader
 *   outruns the decoder, and a stale render must not paint over a newer one.
 *
 *   Pages are not all the same size. Slices off one strip are, but a folder of
 *   scans is not, so leaves are normalised to a common height before being laid
 *   side by side rather than assuming one width for all.
 */
import { clamp } from "../core/geometry.js";

const GAP = 10;         // hairline between two leaves
const TURN_MS = 420;

export function createReader(root, hooks = {}) {
  const $ = (s) => root.querySelector(s);

  const R = {
    root,
    stage: $("#rStage"), book: $("#rBook"), cv: $("#rCanvas"),
    flip: $("#rFlip"), flipFront: $("#rFlipFront"), flipBack: $("#rFlipBack"),
    flipHold: $("#rFlipHold"),
    count: $("#rCount"), title: $("#rTitle"), sub: $("#rSub"),
    bar: $("#rBar"), hint: $("#rHint"), busy: $("#rBusy"),
    close: $("#rClose"), dir: $("#rDir"), fit: $("#rFit"),
    spread: $("#rSpread"), cover: $("#rCover"), anim: $("#rAnim"),
    zoneL: $("#rZoneL"), zoneR: $("#rZoneR")
  };

  const view = {
    open: false, idx: 0, source: null,
    fit: "page", rtl: true,
    spread: "single", spreadAuto: true, coverAlone: true,
    animate: true
  };

  let token = 0;          // guards against a stale async render landing late
  let flipAnim = null;    // the turn in flight, if any
  let rolling = false;    // a chapter change is under way

  /**
   * Navigation runs one step at a time.
   *
   * Turning a page is asynchronous twice over — the next page may still be
   * decoding, and the turn itself takes a fifth of a second. Someone reading
   * quickly taps again inside that, and letting two steps interleave means the
   * page counter and the canvas can disagree about where the reader is.
   *
   * So steps queue instead. A step that has others waiting behind it skips its
   * animation, which keeps a burst of taps feeling immediate rather than
   * playing out a second of turns after the reader has stopped.
   */
  let chain = Promise.resolve();
  let queued = 0;
  function enqueue(fn) {
    queued++;
    // a failed step must not take the queue down with it, but it must still be
    // heard: swallowing it silently leaves the reader frozen with no clue why
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
    } catch (e) {}
  }
  function savePrefs() {
    try {
      localStorage.setItem("manhwa-reader-prefs", JSON.stringify({
        rtl: view.rtl, fit: view.fit, spread: view.spread,
        coverAlone: view.coverAlone, animate: view.animate
      }));
    } catch (e) {}
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
    if (view.spread !== "double") return [i];
    if (view.coverAlone && i === 0) return [0];
    const off = view.coverAlone ? 1 : 0;
    const a = i - ((i - off) % 2);
    return a + 1 < n ? [a, a + 1] : [a];
  }

  // ---------- rendering ----------
  /**
   * Lay the leaves out and paint them. Leaves are scaled to a shared height so
   * a spread of two differently sized scans still meets at the spine.
   */
  function paint(canvas, leaves) {
    const order = view.rtl ? leaves.slice().reverse() : leaves;
    const H = Math.max.apply(null, order.map((p) => p.sh));
    const boxes = order.map((p) => ({ page: p, w: p.sw * (H / p.sh), h: H }));
    const gap = boxes.length > 1 ? GAP : 0;
    const srcW = boxes.reduce((s, b) => s + b.w, 0) + gap * (boxes.length - 1);
    const srcH = H;
    if (srcW <= 0 || srcH <= 0) return null;

    const availW = R.stage.clientWidth, availH = R.stage.clientHeight;
    if (availW <= 0) return null;
    const scale = view.fit === "width" ? availW / srcW : Math.min(availW / srcW, availH / srcH);
    const dw = Math.max(1, Math.round(srcW * scale));
    const dh = Math.max(1, Math.round(srcH * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.round(dw * dpr);
    canvas.height = Math.round(dh * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);   // draw in source units
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, srcW, srcH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    let x = 0;
    for (const b of boxes) {
      const p = b.page;
      ctx.drawImage(p.img, p.sx, p.sy, p.sw, p.sh, x, 0, b.w, b.h);
      x += b.w + gap;
    }
    return { dw, dh, leaves: boxes.length };
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
    const mine = ++token;
    const idxs = pagesAt(view.idx);

    const slow = setTimeout(() => { if (mine === token) R.busy.hidden = false; }, 180);
    let leaves;
    try { leaves = await fetchLeaves(idxs); }
    finally { clearTimeout(slow); }
    if (mine !== token) return null;                 // a newer render won
    R.busy.hidden = true;
    if (!leaves.length) return null;

    const geo = paint(R.cv, leaves);
    if (!geo) return null;
    R.cv.style.width = geo.dw + "px";
    R.cv.style.height = geo.dh + "px";
    R.book.style.width = geo.dw + "px";
    R.book.style.height = geo.dh + "px";
    R.stage.scrollTop = 0;
    // labels move with the pixels. Updating the chapter name anywhere else lets
    // it announce a chapter whose pages are not on screen yet — or, if this
    // render was superseded, one that never arrived at all
    setTitle();
    showCount(idxs);
    return geo;
  }

  function showCount(idxs) {
    const n = view.source.count;
    const label = idxs.length > 1
      ? (idxs[0] + 1) + "–" + (idxs[idxs.length - 1] + 1)
      : String(idxs[0] + 1);
    R.count.textContent = label + " / " + n;
    R.bar.style.width = (n > 1 ? (idxs[idxs.length - 1] / (n - 1)) * 100 : 100) + "%";
  }

  // ---------- the page turn ----------
  /**
   * A spread turns like real paper: one sheet swings about the spine, its front
   * the leaf that is leaving and its back the leaf that arrives on the far side.
   *
   * Two details are what make it read as paper rather than as a card trick.
   *
   *   The far half must keep showing the OLD page until the sheet lands on it.
   *   The destination canvas already holds the finished spread, so without a
   *   held copy the arriving page appears while the sheet is still in mid-air.
   *
   *   A single-page view has no far half, so a full 180° would land the sheet
   *   beside the book showing a page that is already on screen. There the sheet
   *   only swings to edge-on, uncovering the new page beneath it.
   */
  function runTurn(before, after, forward) {
    // A cover standing alone becomes a spread of two. The sheet has no honest
    // size across that change — stretched to the new width it reads as a smear —
    // so that one transition simply cuts.
    if (before.leaves !== after.leaves) return Promise.resolve();

    const dw = after.dw, dh = after.dh;
    const double = after.leaves > 1;
    const half = double ? dw / 2 : dw;
    // reading right-to-left, a forward turn sweeps the left leaf to the right
    const leftward = forward === view.rtl;
    const leafLeft = leftward ? 0 : dw - half;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const faces = double ? [R.flipFront, R.flipBack, R.flipHold] : [R.flipFront];
    for (const c of faces) {
      c.width = Math.max(1, Math.round(half * dpr));
      c.height = Math.max(1, Math.round(dh * dpr));
      c.style.width = half + "px";
      c.style.height = dh + "px";
    }

    // the turning half, as it looks now — cropped in the OLD render's own units,
    // which need not match the new one if the pages differ in size
    const bHalf = double ? before.dw / 2 : before.dw;
    blit(R.flipFront, before.canvas, before.dw, leftward ? 0 : before.dw - bHalf, bHalf);
    R.flipBack.hidden = !double;
    R.flipHold.hidden = !double;
    if (double) {
      const farLeft = dw - half - leafLeft;
      blit(R.flipBack, R.cv, dw, farLeft, half);                       // where it lands
      blit(R.flipHold, before.canvas, before.dw, leftward ? bHalf : 0, bHalf);
      R.flipHold.style.left = farLeft + "px";
    }

    R.flip.style.width = half + "px";
    R.flip.style.height = dh + "px";
    R.flip.style.left = leafLeft + "px";
    R.flip.style.transformOrigin = leftward ? "right center" : "left center";
    R.flip.hidden = false;

    const end = (leftward ? -1 : 1) * (double ? 180 : 90);
    const anim = R.flip.animate(
      [{ transform: "rotateY(0deg)" }, { transform: `rotateY(${end}deg)` }],
      { duration: TURN_MS, easing: double ? "cubic-bezier(.35,.02,.28,1)" : "cubic-bezier(.4,0,.7,.6)" }
    );
    flipAnim = anim;
    return anim.finished.catch(() => {}).then(() => {
      if (flipAnim !== anim) return;         // a faster reader started another
      flipAnim = null;
      R.flip.hidden = true;
      R.flipHold.hidden = true;
    });
  }

  /**
   * Copy a vertical slice of `src` onto `dest`, stretched to fill it.
   * `srcCssW` is what `src` measures on screen — a canvas is backed by more
   * pixels than that on a retina display, so the crop has to be scaled by the
   * ratio between the two rather than taken as given.
   */
  function blit(dest, src, srcCssW, sxCss, swCss) {
    const ratio = srcCssW > 0 ? src.width / srcCssW : 1;
    const ctx = dest.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, dest.width, dest.height);
    ctx.drawImage(src, sxCss * ratio, 0, swCss * ratio, src.height,
                  0, 0, dest.width, dest.height);
  }

  function snapshot() {
    if (!R.cv.width) return null;
    const c = document.createElement("canvas");
    c.width = R.cv.width; c.height = R.cv.height;
    c.getContext("2d").drawImage(R.cv, 0, 0);
    return c;
  }

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function goTo(next, forward) {
    if (flipAnim) { flipAnim.cancel(); flipAnim = null; R.flip.hidden = true; R.flipHold.hidden = true; }

    const wantsTurn = view.animate && !reduceMotion() && queued <= 1;
    const before = wantsTurn
      ? { canvas: snapshot(), dw: parseFloat(R.cv.style.width), dh: parseFloat(R.cv.style.height),
          leaves: pagesAt(view.idx).length }
      : null;

    view.idx = clamp(next, 0, view.source.count - 1);
    saveMark();
    const after = await render();

    if (before && before.canvas && after) await runTurn(before, after, forward);
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
    rolling = true;                     // one chapter at a time, however fast the taps
    R.busy.hidden = false;
    let nextSrc = null;
    try { nextSrc = await step(); } catch (e) {}
    R.busy.hidden = true;
    if (!nextSrc) { rolling = false; flash(dir > 0 ? "마지막 화예요." : "첫 화예요."); return; }
    src.release();
    view.source = nextSrc;
    view.idx = dir > 0 ? 0 : pagesAt(nextSrc.count - 1)[0];
    saveMark();
    flash(nextSrc.title);
    try { await render(); } finally { rolling = false; }
  }

  let flashTimer = null;
  function flash(msg) {
    R.hint.textContent = msg;
    R.hint.style.opacity = "1";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { R.hint.style.opacity = "0"; }, 1800);
  }

  // ---------- chrome ----------
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
    R.anim.textContent = view.animate ? "넘김 켜짐" : "넘김 꺼짐";
    R.anim.setAttribute("aria-pressed", view.animate ? "true" : "false");
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
    setTitle();
    if (view.spreadAuto) {
      // a landscape window has room for two leaves; a phone held upright does not
      const w = window.innerWidth, h = window.innerHeight;
      view.spread = (w / h > 1.15 && w >= 900) ? "double" : "single";
    }
    view.idx = pagesAt(view.idx)[0];
    syncButtons();
    await new Promise((r) => requestAnimationFrame(r));
    // through the queue, so a tap on the first page waits for it to be there
    await enqueue(() => render());
    flash("좌우를 누르거나 ← → 키로 넘기세요 · Esc로 닫기");
  }

  function close() {
    view.open = false;
    token++;                      // abandon anything still decoding
    R.root.hidden = true;
    R.busy.hidden = true;
    document.body.style.overflow = "";
    if (view.source) { view.source.release(); }
    if (hooks.onClose) hooks.onClose();
  }

  // ---------- wiring ----------
  R.close.addEventListener("click", close);
  // the view toggles queue behind page turns for the same reason turns queue
  // behind each other — a re-layout landing mid-turn leaves the canvas and the
  // page counter describing different things
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
    syncButtons(); savePrefs(); await render();
  }));
  R.anim.addEventListener("click", () => {
    view.animate = !view.animate; syncButtons(); savePrefs();
  });
  // In right-to-left reading the LEFT side advances, as in a printed comic.
  const step = (dir) => enqueue(() => go(dir));
  R.zoneL.addEventListener("click", () => step(view.rtl ? 1 : -1));
  R.zoneR.addEventListener("click", () => step(view.rtl ? -1 : 1));

  document.addEventListener("keydown", (e) => {
    if (!view.open) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); step(view.rtl ? 1 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(view.rtl ? -1 : 1); }
    else if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Home") { e.preventDefault(); enqueue(() => goTo(0, false)); }
    else if (e.key === "End") { e.preventDefault(); enqueue(() => goTo(pagesAt(view.source.count - 1)[0], true)); }
    else if (e.key === "d" || e.key === "D") { e.preventDefault(); R.spread.click(); }
  });

  let touchX = null, touchY = null;
  R.stage.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  R.stage.addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
      // swiping left moves forward when reading right-to-left
      step(dx < 0 ? (view.rtl ? -1 : 1) : (view.rtl ? 1 : -1));
    }
  }, { passive: true });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    // through the queue like everything else: a re-layout that lands in the
    // middle of a turn cancels that turn's render and strands its page counter
    resizeTimer = setTimeout(() => { if (view.open) enqueue(() => render()); }, 150);
  });

  loadPrefs();
  syncButtons();

  return { open, close, view };
}
