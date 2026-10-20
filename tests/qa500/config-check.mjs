#!/usr/bin/env node
/**
 * B4 proof — MAX_VIOLATIONS is configuration, not a hardcoded 3.
 *
 * Boots an ISOLATED staging instance on :5174 with MAX_VIOLATIONS=2 (the main
 * `npm run dev:test` server on :5173 is left running), runs the
 * `violation-limit.spec.ts` check against it, then tears it down and restores
 * tests/.artifacts/dev-server.json.
 *
 *   npm run qa500:config-check
 *
 * Output: tests/.artifacts/qa500/max-violations-check.json (read by the report
 * generator, criterion TC-24). Uses the same test DB (.env.test) — still never
 * production (assertNotProduction runs inside start-dev.mjs).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, ARTIFACTS_DIR, readJson } from "../lib/env.mjs";

const PORT = 5174;
const LIMIT = 2;
const DEV_JSON = path.join(ARTIFACTS_DIR, "dev-server.json");
const backupDevJson = fs.existsSync(DEV_JSON) ? fs.readFileSync(DEV_JSON, "utf8") : null;

const env = {
  ...process.env,
  MAX_VIOLATIONS: String(LIMIT),
  APP_URL: `http://localhost:${PORT}`,
  RESEND_MOCK_PORT: "4598",
};

let serverLog = "";
const server = spawn(process.execPath, [path.join(ROOT, "tests", "start-dev.mjs")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (c) => (serverLog += c.toString()));
server.stderr.on("data", (c) => (serverLog += c.toString()));

function waitReady(timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const j = readJson(DEV_JSON);
      if (j?.baseUrl?.includes(`:${PORT}`)) return resolve(j);
      if (server.exitCode !== null) {
        return reject(new Error(`dev server exited (${server.exitCode})\n${serverLog.slice(-3000)}`));
      }
      if (Date.now() > end) {
        return reject(new Error(`dev server on :${PORT} not ready\n${serverLog.slice(-3000)}`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32" });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

let exitCode = 1;
try {
  const srv = await waitReady();
  console.log(`[qa500:config-check] staging on ${srv.baseUrl} with MAX_VIOLATIONS=${LIMIT}`);
  exitCode = await run("npx", [
    "playwright",
    "test",
    "--config",
    "tests/qa500/playwright.qa500.config.ts",
    "--project=desktop-chromium",
    "--headed",
    "tests/qa500/e2e/violation-limit.spec.ts",
  ]);
  const out = readJson(path.join(ARTIFACTS_DIR, "qa500", "max-violations-check.json"));
  console.log(
    out
      ? `[qa500:config-check] artifact: limit=${out.limit} observed=${out.observedCount} pass=${out.pass}`
      : "[qa500:config-check] WARNING: no max-violations-check.json produced",
  );
} catch (e) {
  console.error(`[qa500:config-check] ${e instanceof Error ? e.message : e}`);
} finally {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill("SIGTERM");
  }
  if (backupDevJson) fs.writeFileSync(DEV_JSON, backupDevJson);
  else fs.rmSync(DEV_JSON, { force: true });
  await new Promise((r) => setTimeout(r, 1500));
  console.log("[qa500:config-check] isolated staging stopped; dev-server.json restored");
}
process.exit(exitCode);
