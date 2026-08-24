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
 * the repositories, kept in localStorage. That is device-local, but it is still
 * a credential sitting in a browser — the panel says so.
 *
 * Several repositories can be read at once. GitHub's size guidance is per
 * repository, not per account, so a growing library is meant to spread across
 * repositories — and a reader who has to disconnect and reconnect to change
 * series would feel that split as a chore. The shelf merges them instead.
 */

const API = "https://api.github.com";
const CACHE = "manhwa-github-blobs";
const CONF_KEY = "manhwa-github";

export function loadConf() {
  try { return normalise(JSON.parse(localStorage.getItem(CONF_KEY) || "null")); }
  catch (e) { return null; }
}

/**
 * One shape for one repository and for many.
 *
 * Settings saved before the shelf could merge repositories name a single
 * `owner`/`repo` at the top level. Reading those back as a one-item list keeps
 * an existing install connected across the update instead of silently emptying
 * its shelf.
 */
export function normalise(conf) {
  if (!conf || !conf.token) return null;
  const repos = Array.isArray(conf.repos) && conf.repos.length
    ? conf.repos
    : (conf.owner && conf.repo ? [{ owner: conf.owner, repo: conf.repo,
                                    branch: conf.branch, path: conf.path }] : []);
  const seen = new Set();
  const unique = [];
  for (const r of repos) {
    if (!r || !r.owner || !r.repo) continue;
    const key = (r.owner + "/" + r.repo).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ owner: r.owner, repo: r.repo, branch: r.branch || "", path: r.path || "" });
  }
  return unique.length ? { token: conf.token, repos: unique } : null;
}

/** Add a repository to a connection, or start one. Never duplicates. */
export function withRepo(conf, where, token) {
  const base = conf && conf.token ? conf : { token, repos: [] };
  return normalise({ token: base.token || token, repos: [...(base.repos || []), where] });
}

export function withoutRepo(conf, where) {
  const key = (where.owner + "/" + where.repo).toLowerCase();
  return normalise({
    ...conf,
    repos: (conf.repos || []).filter((r) => (r.owner + "/" + r.repo).toLowerCase() !== key)
  });
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

/** Everything one repository needs: the shared token plus where to look. */
const siteOf = (conf, r) => ({ token: conf.token, owner: r.owner, repo: r.repo,
                               branch: r.branch, path: r.path });

export const repoLabel = (r) => {
  const scope = (r.path || "").replace(/^\/+|\/+$/g, "");
  return r.owner + "/" + r.repo + (scope ? "/" + scope : "");
};

/** One repository's blobs, as paths the library can name things from. */
async function repoEntries(site, prefix) {
  const scope = (site.path || "").replace(/^\/+|\/+$/g, "");
  const ref = site.branch || "HEAD";
  const res = await api(site,
    `${API}/repos/${site.owner}/${site.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const tree = await res.json();
  if (tree.truncated) {
    throw new Error(site.repo + " 저장소가 너무 커서 목록이 잘렸어요. 하위 경로를 지정해 주세요.");
  }
  return (tree.tree || [])
    .filter((n) => n.type === "blob")
    .filter((n) => !scope || n.path === scope || n.path.startsWith(scope + "/"))
    .map((n) => ({
      // keep the scope folder's own name so it can title an unnamed series
      path: prefix + (scope ? n.path.slice(scope.lastIndexOf("/") + 1) : n.path),
      load: () => loadBlob(site, n.sha)
    }));
}

/**
 * A page source over one or more repositories.
 *
 * With more than one, every path gains its repository's name in front. That is
 * not decoration: the library reads a series from the folder above a chapter,
 * so two repositories each holding one series at their root would otherwise
 * both come out unnamed and merge into one. The repository name is also the
 * most honest series title available in that case.
 *
 * A repository that cannot be read does not empty the shelf. It is reported in
 * `notes` and the rest still loads — a token whose access to one of five
 * repositories lapsed should cost one series, not the library.
 */
export function createGithubProvider(conf) {
  const c = normalise(conf);
  if (!c) throw new Error("연결 정보가 비어 있어요.");
  const many = c.repos.length > 1;
  const provider = {
    label: many ? "저장소 " + c.repos.length + "곳" : repoLabel(c.repos[0]),
    notes: [],
    async entries() {
      const results = await Promise.all(c.repos.map((r) =>
        repoEntries(siteOf(c, r), many ? r.repo + "/" : "")
          .then((list) => ({ list }), (err) => ({ err, r }))));
      provider.notes = results.filter((x) => x.err)
        .map((x) => repoLabel(x.r) + " — " + (x.err.message || "읽지 못했어요."));
      const ok = results.filter((x) => x.list);
      if (!ok.length) throw results[0].err;   // nothing readable: this is a failure
      return ok.flatMap((x) => x.list);
    }
  };
  return provider;
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
 * (the repositories, from what the token can reach) or almost never needed (a
 * branch other than the default, a sub-folder). Asking for five things to read
 * one folder of comics was the wrong trade.
 *
 * Repositories are added and removed rather than swapped. A library outgrows
 * one repository long before it outgrows a token, and switching between them to
 * read is not something a reader should have to think about.
 *
 * Calls `onConnect(provider)` when there is something to read.
 */
export function githubPanel(els, toast, onConnect) {
  let pending = "";                     // the token being tried, before it is saved
  let known = [];                       // repositories the token listed, if it could

  function screen(which) {
    els.ghForm.hidden = which !== "form";
    els.ghPick.hidden = which !== "pick";
    els.ghManual.hidden = which !== "manual";
    els.ghConnected.hidden = which !== "connected";
  }

  function showConnected(conf) {
    if (!conf) { screen("form"); return; }
    els.ghRepoList.innerHTML = "";
    for (const r of conf.repos) {
      const row = document.createElement("div");
      row.className = "repo-line";
      const name = document.createElement("span");
      name.className = "mono";
      name.textContent = repoLabel(r);
      const drop = document.createElement("button");
      drop.className = "repo-drop";
      drop.type = "button";
      drop.title = "이 저장소 빼기";
      drop.setAttribute("aria-label", repoLabel(r) + " 빼기");
      drop.textContent = "×";
      drop.addEventListener("click", () => remove(r));
      row.append(name, drop);
      els.ghRepoList.appendChild(row);
    }
    screen("connected");
  }

  /** Read the whole connection; on success remember it. Reports partial gaps. */
  async function apply(conf, { keepScreen } = {}) {
    const provider = createGithubProvider(conf);
    await onConnect(provider);            // throws if nothing at all can be read
    saveConf(conf);
    els.ghToken.value = "";
    if (provider.notes.length) toast(provider.notes[0]);
    if (!keepScreen) showConnected(conf);
    return conf;
  }

  async function add(where, opts) {
    const next = withRepo(loadConf(), where, pending);
    const before = loadConf();
    if (before && next.repos.length === before.repos.length) {
      toast("이미 연결된 저장소예요.");
      return before;
    }
    return await apply(next, opts);
  }

  async function remove(where, opts) {
    const next = withoutRepo(loadConf(), where);
    if (!next) {                          // the last one: that is a disconnect
      clearConf();
      await onConnect(null);
      if (!(opts && opts.keepScreen)) showConnected(null);
      return;
    }
    try { await apply(next, opts); }
    catch (err) { toast(err.message || "저장소를 읽지 못했어요."); }
  }

  async function begin() {
    const token = els.ghToken.value.trim();
    if (!token) { toast("토큰을 붙여넣어 주세요."); return; }
    pending = token;
    els.ghConnectBtn.disabled = true;
    try {
      known = await listRepos(token);
      if (known.length === 1) { await add(known[0]); return; }
      if (known.length > 1) { offer(); return; }
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

  /**
   * The list of readable repositories, with the connected ones ticked.
   *
   * It stays open after a click so several can be added in one pass — the
   * common case for somebody who just uploaded three series.
   */
  function offer() {
    const conf = loadConf();
    const on = new Set((conf ? conf.repos : []).map((r) =>
      (r.owner + "/" + r.repo).toLowerCase()));
    els.ghPickList.innerHTML = "";
    for (const r of known) {
      const key = (r.owner + "/" + r.repo).toLowerCase();
      const b = document.createElement("button");
      b.className = "repo-row" + (on.has(key) ? " on" : "");
      b.textContent = (on.has(key) ? "✓ " : "") + (r.full || (r.owner + "/" + r.repo));
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          // stay on the list: this screen is where several are taken in one pass
          const here = { keepScreen: true };
          if (on.has(key)) await remove(r, here); else await add(r, here);
          offer();                        // redraw ticks against what is saved now
        } catch (err) {
          toast(err.message || "연결하지 못했어요.");
          b.disabled = false;
        }
      });
      els.ghPickList.appendChild(b);
    }
    els.ghPickDone.hidden = !conf;
    screen("pick");
  }

  els.ghConnectBtn.addEventListener("click", begin);
  els.ghToken.addEventListener("keydown", (e) => { if (e.key === "Enter") begin(); });
  els.ghPickBack.addEventListener("click", () => showConnected(loadConf()));
  els.ghPickDone.addEventListener("click", () => showConnected(loadConf()));
  // a listing can be incomplete — a repository missing from it is still readable
  // if the token was granted it, so never make the list the only way through
  els.ghPickManual.addEventListener("click", () => {
    els.ghManualWhy.textContent = "읽을 저장소 주소를 넣어주세요.";
    screen("manual");
  });

  els.ghManualBtn.addEventListener("click", async () => {
    const where = parseRepo(els.ghRepo.value);
    if (!where) { toast("사용자명/저장소 형태로 넣어주세요."); return; }
    try { await add(where); els.ghRepo.value = ""; }
    catch (err) { toast(err.message || "연결하지 못했어요."); }
  });

  els.ghReloadBtn.addEventListener("click", async () => {
    const conf = loadConf();
    if (!conf) return;
    try { await apply(conf, { keepScreen: true }); }
    catch (err) { toast(err.message || "저장소를 읽지 못했어요."); }
  });

  /**
   * Add another repository, keeping the token and the downloaded pages.
   *
   * GitHub's size guidance is per repository, so a library that keeps growing
   * is meant to spread out. Adding must therefore be cheap, and must never cost
   * the pages already fetched — those are keyed by content hash and stay valid.
   */
  els.ghAddBtn.addEventListener("click", async () => {
    const conf = loadConf();
    if (!conf) { screen("form"); return; }
    pending = conf.token;
    els.ghAddBtn.disabled = true;
    try {
      known = await listRepos(conf.token);
      // a list holding nothing new is not a choice — offering it would be a
      // dead end, and the repository wanted is then one the token cannot list
      const on = new Set(conf.repos.map((r) => (r.owner + "/" + r.repo).toLowerCase()));
      if (known.some((r) => !on.has((r.owner + "/" + r.repo).toLowerCase()))) offer();
      else {
        els.ghManualWhy.textContent = "읽을 저장소 주소를 넣어주세요.";
        screen("manual");
      }
    } catch (err) {
      toast(err.message || "저장소 목록을 읽지 못했어요.");
    } finally {
      els.ghAddBtn.disabled = false;
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
