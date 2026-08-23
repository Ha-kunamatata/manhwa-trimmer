/**
 * Inline the whole app into one self-contained HTML file.
 *
 * The hosted PWA loads ES modules over HTTP, but a Claude Artifact must be a
 * single file with no external requests. This flattens the module graph into
 * one <script> and inlines the stylesheet.
 *
 *   node scripts/build-artifact.mjs  ->  dist/artifact.html
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seen = new Set();
const chunks = [];

/** Depth-first inline of `import ... from "./x.js"` so dependencies come first. */
async function inline(file) {
  const abs = resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);
  let src = await readFile(abs, "utf8");

  const imports = [...src.matchAll(/^\s*import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm)];
  for (const m of imports) {
    const spec = m[1];
    if (spec.startsWith(".")) await inline(resolve(dirname(abs), spec));
  }

  src = src
    .replace(/^\s*import\s+(?:[\s\S]*?)\s+from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*export\s+(?=(?:default\s+)?(?:function|const|let|var|class|async))/gm, "")
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "");

  chunks.push(`/* ---- ${abs.slice(root.length + 1)} ---- */\n${src.trim()}`);
}

const html = await readFile(resolve(root, "index.html"), "utf8");
const css = await readFile(resolve(root, "src/styles.css"), "utf8");
await inline(resolve(root, "src/ui/app.js"));

const body = html
  .slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .trim();

// An artifact is wrapped in its own skeleton at publish time, so emit only
// <title>, the font link, <style> and the body — no doctype/html/head/body.
const out = `<title>만화 재단기</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;700&family=Noto+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">

<style>
${css.trim()}
</style>

${body}

<script>
(function(){
"use strict";
${chunks.join("\n\n")}

initApp();
})();
</script>
`;

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/artifact.html"), out);
console.log(`dist/artifact.html — ${(out.length / 1024).toFixed(1)} KB from ${seen.size} modules`);
