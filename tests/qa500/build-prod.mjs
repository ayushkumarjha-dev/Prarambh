#!/usr/bin/env node
/**
 * B7 — production build for the throughput measurement.
 *
 *   npm run qa500:build
 *
 * Builds with the Nitro node-server preset so the output can be served by
 * plain Node (`tests/qa500/prod-server.mjs`) across several workers.
 *
 * `--mode test` keeps Vite pointed at .env.test (staging fixture DB), so no
 * production value is ever baked into the bundle. Server-side secrets are read
 * from process.env at runtime, never inlined.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "../lib/env.mjs";

const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [viteBin, "build", "--mode", "test"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NITRO_PRESET: "node-server", NODE_ENV: "production" },
  });
  child.on("exit", (c) => resolve(c ?? 1));
});

if (code === 0) {
  console.log("[qa500:build] built .output/server (node-server preset)");
} else {
  console.error(`[qa500:build] build failed (exit ${code})`);
}
process.exit(code);
