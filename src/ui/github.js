/**
 * Reading a private repository of comics.
 *
 * The whole file list comes from one request. The Git Trees API returns every
 * path in the repository with `?recursive=1`, which beats walking the Contents
 * API folder by folder — a library of fifty series would otherwise cost fifty
 * round trips before a single page appeared.
 *
 * Pages are then fetched as blobs by SHA. A SHA names the exact bytes, so a
 * cached page can never be stale, and the Cache API entry needs no expiry.
 *
 * The token is a fine-grained personal access token with read-only Contents on
 * the one repository, kept in localStorage. That is device-local, but it is
 * still a credential sitting in a browser — the panel says so.
 */

const API = "https://api.github.com";
const CACHE = "manhwa-github-blobs";
const CONF_KEY = "manhwa-github";

export function loadConf() {
  try { return JSON.parse(localStorage.getItem(CONF_KEY) || "null"); } catch (e) { return null; }
}
function saveConf(conf) {
  try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch (e) {}
}
function clearConf() {
  try { localStorage.removeItem(CONF_KEY); } catch (e) {}
}

async function api(conf, url, accept) {
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + conf.token,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (res.status === 401) throw new Error("토큰이 거부됐어요. 다시 발급해 주세요.");
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    throw new Error("GitHub 요청 한도를 다 썼어요. 한 시간 뒤에 다시 시도해 주세요.");
  if (res.status === 404) throw new Error(await explain404(conf));
  if (!res.ok) throw new Error("GitHub 오류 " + res.status);
  return res;
}

/**
 * Say which kind of 404 this is.
 *
 * GitHub answers 404 rather than 403 for a repository a token cannot see, so
 * that a token cannot be used to probe for private repositories. Helpful for
 * security, useless for setup: a wrong repository name and a token that simply
 * was not granted this repository look identical, and those are the two mistakes
 * people actually make.
 *
 * Asking who the token belongs to separates them. If that works the token is
 * fine and the problem is its Repository access; if it does not, the token is.
 */
async function explain404(conf) {
  let who = null;
  try {
    const res = await fetch(API + "/user", {
      headers: { Authorization: "Bearer " + conf.token, Accept: "application/vnd.github+json" }
    });
    if (res.ok) who = (await res.json()).login;
  } catch (e) { /* offline, or blocked — fall through to the vaguer message */ }

  const where = conf.owner + "/" + conf.repo;
  if (!who) return "저장소를 찾지 못했어요. 소유자와 저장소 이름을 확인해 주세요.";
  if (who.toLowerCase() !== String(conf.owner).toLowerCase()) {
    return "토큰은 " + who + " 계정 것인데 " + where + "를 찾고 있어요. "
      + "소유자 이름이 맞는지, 그 저장소가 토큰에 포함됐는지 확인해 주세요.";
  }
  return "토큰은 유효한데 " + where + "에 접근할 수 없어요. 토큰의 "
    + "Repository access에 이 저장소가 들어 있는지, Permissions의 Contents가 "
    + "Read-only인지 확인해 주세요.";
}

/** Fetch a page's bytes, preferring the immutable cache over the network. */
async function loadBlob(conf, sha) {
  const key = "https://manhwa.local/blob/" + sha;
  let store = null;
  try { store = await caches.open(CACHE); } catch (e) {}
  if (store) {
    const hit = await store.match(key);
    if (hit) return await hit.blob();
  }
  const res = await api(conf, `${API}/repos/${conf.owner}/${conf.repo}/git/blobs/${sha}`,
                        "application/vnd.github.raw");
  const blob = await res.blob();
  // a SHA is the content, so this entry can never go stale
  if (store) { try { await store.put(key, new Response(blob.slice())); } catch (e) {} }
  return blob;
}

export function createGithubProvider(conf) {
  const scope = (conf.path || "").replace(/^\/+|\/+$/g, "");
  return {
    label: conf.owner + "/" + conf.repo + (scope ? "/" + scope : ""),
    async entries() {
      const ref = conf.branch || "HEAD";
      const res = await api(conf,
        `${API}/repos/${conf.owner}/${conf.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      const tree = await res.json();
      if (tree.truncated) {
        throw new Error("저장소가 너무 커서 목록이 잘렸어요. 하위 경로를 지정해 주세요.");
      }
      return (tree.tree || [])
        .filter((n) => n.type === "blob")
        .filter((n) => !scope || n.path === scope || n.path.startsWith(scope + "/"))
        .map((n) => ({
          // keep the scope folder's own name so it can title an unnamed series
          path: scope ? n.path.slice(scope.lastIndexOf("/") + 1) : n.path,
          load: () => loadBlob(conf, n.sha)
        }));
    }
  };
}

/**
 * Which repositories this token can read.
 *
 * A fine-grained token is usually granted exactly one repository, which means
 * the token already knows where the comics are — asking for an owner and a
 * repository name on top of it is asking the reader to repeat themselves. When
 * the answer is a single repository there is nothing left to ask at all.
 */
export async function listRepos(token) {
  const res = await fetch(API + "/user/repos?per_page=100&sort=updated", {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (res.status === 401) throw new Error("토큰이 거부됐어요. 다시 발급해 주세요.");
  if (!res.ok) return [];                      // older tokens cannot list; ask instead
  const list = await res.json();
  return (Array.isArray(list) ? list : [])
    .map((r) => ({ owner: r.owner && r.owner.login, repo: r.name, full: r.full_name }))
    .filter((r) => r.owner && r.repo);
}

/** Accept whatever someone pastes: a full URL, or just `owner/repo`. */
export function parseRepo(text) {
  const t = String(text || "").trim().replace(/\.git$/, "");
  const m = t.match(/github\.com[/:]+([^/\s]+)\/([^/\s?#]+)/i)
         || t.match(/^([^/\s]+)\/([^/\s?#]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Wire the connect / disconnect panel.
 *
 * One field: the token. Everything the old form asked for is either derivable
 * (the repository, from what the token can reach) or almost never needed (a
 * branch other than the default, a sub-folder). Asking for five things to read
 * one folder of comics was the wrong trade.
 *
 * Calls `onConnect(provider)` when there is something to read.
 */
export function githubPanel(els, toast, onConnect) {
  let pending = "";                     // the token being tried, before it is saved

  function screen(which) {
    els.ghForm.hidden = which !== "form";
    els.ghPick.hidden = which !== "pick";
    els.ghManual.hidden = which !== "manual";
    els.ghConnected.hidden = which !== "connected";
  }

  function showConnected(conf) {
    if (conf) els.ghWhere.textContent = createGithubProvider(conf).label;
    screen(conf ? "connected" : "form");
  }

  /** Try one repository; on success remember it and hand it to the library. */
  async function connect(conf) {
    const provider = createGithubProvider(conf);
    await onConnect(provider);            // throws if the repository cannot be read
    saveConf(conf);
    els.ghToken.value = "";
    showConnected(conf);
  }

  async function begin() {
    const token = els.ghToken.value.trim();
    if (!token) { toast("토큰을 붙여넣어 주세요."); return; }
    pending = token;
    els.ghConnectBtn.disabled = true;
    try {
      const repos = await listRepos(token);
      if (repos.length === 1) {
        await connect({ token, owner: repos[0].owner, repo: repos[0].repo });
        return;
      }
      if (repos.length > 1) { offer(repos); return; }
      // the token cannot list what it can reach — ask for the one thing missing
      els.ghManualWhy.textContent =
        "토큰으로 저장소를 찾지 못했어요. 주소를 직접 넣어주세요.";
      screen("manual");
    } catch (err) {
      toast(err.message || "연결하지 못했어요.");
    } finally {
      els.ghConnectBtn.disabled = false;
    }
  }

  function offer(repos) {
    els.ghPickList.innerHTML = "";
    for (const r of repos) {
      const b = document.createElement("button");
      b.className = "repo-row";
      b.textContent = r.full || (r.owner + "/" + r.repo);
      b.addEventListener("click", async () => {
        try { await connect({ token: pending, owner: r.owner, repo: r.repo }); }
        catch (err) { toast(err.message || "연결하지 못했어요."); }
      });
      els.ghPickList.appendChild(b);
    }
    screen("pick");
  }

  els.ghConnectBtn.addEventListener("click", begin);
  els.ghToken.addEventListener("keydown", (e) => { if (e.key === "Enter") begin(); });
  els.ghPickBack.addEventListener("click", () => screen("form"));

  els.ghManualBtn.addEventListener("click", async () => {
    const where = parseRepo(els.ghRepo.value);
    if (!where) { toast("사용자명/저장소 형태로 넣어주세요."); return; }
    try { await connect({ token: pending, ...where }); }
    catch (err) { toast(err.message || "연결하지 못했어요."); }
  });

  els.ghReloadBtn.addEventListener("click", async () => {
    const conf = loadConf();
    if (!conf) return;
    try { await onConnect(createGithubProvider(conf)); }
    catch (err) { toast(err.message || "저장소를 읽지 못했어요."); }
  });

  /**
   * Go back to choosing, keeping the token and the downloaded pages.
   *
   * Picking the wrong repository is easy — an account can hold one named for
   * the app and another for the comics. Making that mistake cost a disconnect,
   * which also threw away every page already fetched, so the cheap error had an
   * expensive undo.
   */
  els.ghSwitchBtn.addEventListener("click", async () => {
    const conf = loadConf();
    if (!conf) { screen("form"); return; }
    pending = conf.token;
    els.ghSwitchBtn.disabled = true;
    try {
      const repos = await listRepos(conf.token);
      if (repos.length > 1) offer(repos);
      else {
        els.ghManualWhy.textContent = "읽을 저장소 주소를 넣어주세요.";
        screen("manual");
      }
    } catch (err) {
      toast(err.message || "저장소 목록을 읽지 못했어요.");
    } finally {
      els.ghSwitchBtn.disabled = false;
    }
  });

  els.ghForgetBtn.addEventListener("click", async () => {
    clearConf();
    try { await caches.delete(CACHE); } catch (e) {}
    showConnected(null);
    toast("저장된 토큰과 내려받은 페이지를 지웠어요.");
  });

  els.ghToggle.addEventListener("click", () => {
    els.ghPanel.hidden = !els.ghPanel.hidden;
    els.ghToggle.setAttribute("aria-expanded", els.ghPanel.hidden ? "false" : "true");
  });

  showConnected(loadConf());
}
