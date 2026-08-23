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
  if (res.status === 404) throw new Error("저장소나 경로를 찾지 못했어요. 토큰 권한도 확인해 주세요.");
  if (!res.ok) throw new Error("GitHub 오류 " + res.status);
  return res;
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

/** Wire the connect / disconnect panel. Calls `onConnect(provider)` when ready. */
export function githubPanel(els, toast, onConnect) {
  const fields = () => ({
    token: els.ghToken.value.trim(),
    owner: els.ghOwner.value.trim(),
    repo: els.ghRepo.value.trim(),
    branch: els.ghBranch.value.trim(),
    path: els.ghPath.value.trim()
  });

  function showConnected(conf) {
    els.ghForm.hidden = !!conf;
    els.ghConnected.hidden = !conf;
    if (conf) els.ghWhere.textContent = createGithubProvider(conf).label;
  }

  els.ghConnectBtn.addEventListener("click", async () => {
    const conf = fields();
    if (!conf.token || !conf.owner || !conf.repo) {
      toast("토큰, 소유자, 저장소 이름이 필요해요.");
      return;
    }
    els.ghConnectBtn.disabled = true;
    try {
      const provider = createGithubProvider(conf);
      await onConnect(provider);
      saveConf(conf);
      showConnected(conf);
      els.ghToken.value = "";                   // no need to keep it on screen
    } catch (err) {
      toast(err.message || "연결하지 못했어요.");
    } finally {
      els.ghConnectBtn.disabled = false;
    }
  });

  els.ghReloadBtn.addEventListener("click", async () => {
    const conf = loadConf();
    if (!conf) return;
    try { await onConnect(createGithubProvider(conf)); }
    catch (err) { toast(err.message || "저장소를 읽지 못했어요."); }
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
