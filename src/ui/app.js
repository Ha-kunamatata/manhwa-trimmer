/**
 * The shell — two halves of one app.
 *
 * Reading is the front door. Cutting a capture is something you do once per
 * chapter; reading is what brings anyone back, so the app opens on the library
 * and the editor sits behind a button in the header. There is no separate
 * landing screen to step through first.
 *
 * Views are addressed by hash so the back button works and a phone's home-screen
 * shortcut can point straight at either half.
 */
import { initEditor } from "./editor.js";
import { createReader } from "./reader.js";
import { createLibrary } from "./library.js";

export function initApp() {
  const $ = (s) => document.querySelector(s);

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ---------- views ----------
  const views = { edit: $("#editView"), library: $("#libView") };
  const shell = $("#appShell");

  function show(name) {
    const view = views[name] ? name : "library";
    for (const [k, el] of Object.entries(views)) el.hidden = k !== view;
    shell.dataset.view = view;
    // the way out of the editor and the way into it are the same slot
    $("#backHome").hidden = view !== "edit";
    $("#goEdit").hidden = view === "edit";
    $("#brandSub").textContent = view === "edit"
      ? "긴 캡처를 만화책 판형으로 잘라 저장합니다"
      : "폴더나 저장소를 골라 만화책처럼 읽습니다";
    window.scrollTo(0, 0);
  }

  /**
   * Offer to pick up where reading stopped.
   *
   * Sits at the top of the library, above the pickers, because coming back to a
   * comic mid-chapter is the single most common reason to open this at all —
   * and the alternative is three taps through folders every time.
   */
  function showResume() {
    const card = $("#resumeCard");
    const last = library && library.lastRead();
    card.hidden = !last;
    if (!last) return;
    $("#resumeWhere").textContent = last.series + " · " + last.chapter;
    $("#resumePage").textContent =
      (last.page + 1) + (last.total ? " / " + last.total : "") + "쪽";
  }

  $("#resumeCard").addEventListener("click", async () => {
    const card = $("#resumeCard");
    card.disabled = true;
    try {
      // the folder may no longer be reachable — most browsers forget it — so
      // falling back to the picker is the normal outcome, not an error
      if (!(await library.resume())) toast("폴더를 다시 골라주세요.");
    } finally { card.disabled = false; }
  });

  function routeFromHash() {
    const name = (location.hash || "").replace(/^#\/?/, "") || "library";
    show(name);
    if (name !== "edit") showResume();
  }
  const goto = (name) => { location.hash = name === "library" ? "" : "#/" + name; };

  window.addEventListener("hashchange", routeFromHash);
  $("#goEdit").addEventListener("click", () => goto("edit"));
  $("#backHome").addEventListener("click", () => goto("library"));

  // ---------- reader, shared by both halves ----------
  let library = null;
  const reader = createReader($("#reader"), {
    onProgress: (src, page) => { if (library) library.onProgress(src, page); },
    // a pin can point into a chapter that is not the one being read
    onJump: async (pin) => {
      if (!library) return false;
      const ok = await library.jumpTo(pin);
      if (!ok) toast("그 만화가 지금 열려 있지 않아요. 폴더를 먼저 골라주세요.");
      return ok;
    },
    onClose: () => {
      if (!library) return;
      library.refresh();
      if (shell.dataset.view === "library") showResume();
    }
  });
  const openReader = (source, index) => reader.open(source, index);

  initEditor(openReader, toast);

  // the single-file artifact build cannot reach GitHub; offering it would only
  // produce a network error the user cannot do anything about
  if (window.__manhwaArtifact) $("#ghToggle").hidden = true;

  library = createLibrary({
    libEmpty: $("#libEmpty"), libBody: $("#libBody"), libStatus: $("#libStatus"),
    libSource: $("#libSource"), libCrumbs: $("#libCrumbs"),
    seriesGrid: $("#seriesGrid"), chapterList: $("#chapterList"),
    pickFolderBtn: $("#pickFolderBtn"), pickFilesBtn: $("#pickFilesBtn"),
    resumeBtn: $("#resumeBtn"),
    folderInput: $("#folderInput"), filesInput: $("#filesInput"),
    ghToggle: $("#ghToggle"), ghPanel: $("#ghPanel"), ghForm: $("#ghForm"),
    ghConnected: $("#ghConnected"), ghWhere: $("#ghWhere"),
    ghToken: $("#ghToken"), ghConnectBtn: $("#ghConnectBtn"),
    ghPick: $("#ghPick"), ghPickList: $("#ghPickList"), ghPickBack: $("#ghPickBack"), ghPickManual: $("#ghPickManual"),
    ghManual: $("#ghManual"), ghRepo: $("#ghRepo"),
    ghManualBtn: $("#ghManualBtn"), ghManualWhy: $("#ghManualWhy"),
    ghReloadBtn: $("#ghReloadBtn"), ghSwitchBtn: $("#ghSwitchBtn"),
    ghForgetBtn: $("#ghForgetBtn")
  }, openReader, toast);

  routeFromHash();
}
