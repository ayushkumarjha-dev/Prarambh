/**
 * QA-500 Playwright configuration — browser/matrix tests for full-screen,
 * split-screen, auto-submit and edge cases. The server is NOT managed here:
 * start staging first with `npm run dev:test` (writes tests/.artifacts/
 * dev-server.json). Staging DB = .env.test only (safety rule 0).
 */
import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function baseURL() {
  try {
    const f = path.join(HERE, "..", ".artifacts", "dev-server.json");
    return JSON.parse(fs.readFileSync(f, "utf8")).baseUrl as string;
  } catch {
    return process.env.APP_URL ?? "http://localhost:5173";
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // specs share the staging DB — keep runs strictly serial
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(HERE, "..", ".artifacts", "qa500", "e2e-results.json") }],
  ],
  outputDir: path.join(HERE, "..", ".artifacts", "qa500", "e2e-output"),
  use: {
    baseURL: baseURL(),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
