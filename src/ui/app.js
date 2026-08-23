/**
 * The shell — two halves of one app.
 *
 * 편집 cuts a long capture into pages. 뷰어 reads pages that already exist, from
 * a folder or a repository. They share the reader and nothing else, so this file
 * does only three things: pick a view, own the reader, and hand out the toast.
 *
 * Views are addressed by hash so the back button works and a phone's home-screen
 * shortcut can point straight at the library.
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
  const views = { home: $("#homeView"), edit: $("#editView"), library: $("#libView") };
  const shell = $("#appShell");

  function show(name) {
    const view = views[name] ? name : "home";
    for (const [k, el] of Object.entries(views)) el.hidden = k !== view;
    shell.dataset.view = view;
    $("#backHome").hidden = view === "home";
    $("#brandSub").textContent =
      view === "edit" ? "긴 캡처를 만화책 판형으로 잘라 저장합니다"
      : view === "library" ? "폴더나 저장소를 골라 만화책처럼 읽습니다"
      : "긴 캡처를 자르고, 만화책처럼 읽습니다";
    window.scrollTo(0, 0);
  }

  function routeFromHash() {
    show((location.hash || "").replace(/^#\/?/, "") || "home");
  }
  const goto = (name) => { location.hash = name === "home" ? "" : "#/" + name; };

  window.addEventListener("hashchange", routeFromHash);
  $("#goEdit").addEventListener("click", () => goto("edit"));
  $("#goLibrary").addEventListener("click", () => goto("library"));
  $("#backHome").addEventListener("click", () => goto("home"));

  // ---------- reader, shared by both halves ----------
  let library = null;
  const reader = createReader($("#reader"), {
    onProgress: (src, page) => { if (library) library.onProgress(src, page); },
    onClose: () => { if (library) library.refresh(); }
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
    ghToken: $("#ghToken"), ghOwner: $("#ghOwner"), ghRepo: $("#ghRepo"),
    ghBranch: $("#ghBranch"), ghPath: $("#ghPath"),
    ghConnectBtn: $("#ghConnectBtn"), ghReloadBtn: $("#ghReloadBtn"),
    ghForgetBtn: $("#ghForgetBtn")
  }, openReader, toast);

  routeFromHash();
}
