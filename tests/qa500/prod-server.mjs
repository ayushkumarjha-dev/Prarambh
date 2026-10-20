#!/usr/bin/env node
/**
 * B7 — run the built app with N worker processes on one port.
 *
 *   npm run qa500:build && npm run qa500:serve
 *   QA500_PROD_WORKERS=4 QA500_PROD_PORT=5180 npm run qa500:serve
 *
 * The production build removes the dev-only module runner, and the cluster
 * shares one listening socket so the login burst parallelises across cores.
 * Still staging-only: .env.test is loaded and assertNotProduction() refuses to
 * start against the production database (safety rule 0).
 */
import cluster from "node:cluster";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadTestEnv, assertNotProduction } from "../lib/env.mjs";

loadTestEnv();
assertNotProduction(process.env.TURSO_DATA ?? process.env.TURSO_DATABASE_URL);

const PORT = Number(process.env.QA500_PROD_PORT ?? 5180);
const WORKERS = Number(process.env.QA500_PROD_WORKERS ?? 4);
const ENTRY = path.join(ROOT, ".output", "server", "index.mjs");

if (!fs.existsSync(ENTRY)) {
  console.error(`[qa500:serve] missing ${ENTRY} — run: npm run qa500:build`);
  process.exit(1);
}

if (cluster.isPrimary) {
  console.log(`[qa500:serve] primary ${process.pid} — ${WORKERS} workers on :${PORT}`);
  console.log(`[qa500:serve] db: ${process.env.TURSO_DATABASE_URL}`);
  for (let i = 0; i < WORKERS; i += 1) cluster.fork();
  cluster.on("exit", (worker, code) => {
    console.log(`[qa500:serve] worker ${worker.process.pid} exited (${code})`);
  });
  const stop = () => {
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  process.env.PORT = String(PORT);
  process.env.NITRO_PORT = String(PORT);
  process.env.HOST = "127.0.0.1";
  await import(ENTRY);
  console.log(`[qa500:serve] worker ${process.pid} up on :${PORT}`);
}
