import { initApp } from "./ui/app.js";

initApp();

// Register the service worker so the tool works offline and installs as an app.
// It is skipped on file:// and inside the single-file artifact build.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: "./" })
      .catch(() => { /* offline support is a bonus, never a requirement */ });
  });
}
