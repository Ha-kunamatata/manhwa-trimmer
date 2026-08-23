import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// Some sandboxes ship a prebuilt Chromium instead of Playwright's download.
// Use it when present; CI installs browsers the normal way.
const local = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const launchOptions = !process.env.CI && existsSync(local) ? { executablePath: local } : {};

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "on-first-retry",
    launchOptions
  },
  webServer: {
    command: "python3 -m http.server 8080",
    url: "http://127.0.0.1:8080/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1400, height: 900 } } },
    { name: "phone",   use: { viewport: { width: 390, height: 844 } } }
  ]
});
