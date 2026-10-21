#!/usr/bin/env node
/**
 * B7 — run the built app as N independent instances on consecutive ports.
 *
 *   npm run qa500:build && npm run qa500:serve
 *   QA500_PROD_WORKERS=4 QA500_PROD_PORT=5180 npm run qa500:serve
 *
 * Why not `node:cluster`: Nitro's node-server calls `listen({exclusive:true})`,
 * so on Windows every worker binds its own socket and the OS hands every
 * connection to one of them — the extra processes sit idle. Independent
 * instances on separate ports + a round-robin client (k6 BASE_URLS) model the
 * real deployment: N app servers behind a load balancer sharing one database.
 *
 * Still staging-only: .env.test is loaded and assertNotProduction() refuses to
 * start against the production database (safety rule 0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, loadTestEnv, assertNotProduction } from "../lib/env.mjs";

loadTestEnv();
assertNotProduction(process.env.TURSO_DATA ?? process.env.TURSO_DATABASE_URL);

const BASE_PORT = Number(process.env.QA500_PROD_PORT ?? 5180);
const WORKERS = Number(process.env.QA500_PROD_WORKERS ?? 4);
const ENTRY = path.join(ROOT, ".output", "server", "index.mjs");

if (!fs.existsSync(ENTRY)) {
  console.error(`[qa500:serve] missing ${ENTRY} — run: npm run qa500:build`);
  process.exit(1);
}

const ports = Array.from({ length: WORKERS }, (_, i) => BASE_PORT + i);
const children = [];

// The report reads this to describe the measured deployment shape (B7).
const ART_DIR = path.join(ROOT, "tests", ".artifacts", "qa500");
fs.mkdirSync(ART_DIR, { recursive: true });
fs.writeFileSync(
  path.join(ART_DIR, "prod-deployment.json"),
  JSON.stringify(
    { instances: WORKERS, ports, logicalCpus: os.cpus().length, cpu: os.cpus()[0]?.model?.trim(), database: process.env.TURSO_DATABASE_URL, startedAt: new Date().toISOString() },
    null,
    2,
  ),
);

console.log(`[qa500:serve] ${WORKERS} instance(s) on ${ports.map((p) => `:${p}`).join(", ")}`);
console.log(`[qa500:serve] db: ${process.env.TURSO_DATABASE_URL}`);
console.log(`[qa500:serve] k6: -e BASE_URLS=${ports.map((p) => `http://localhost:${p}`).join(",")} -e PROD=1`);

for (const port of ports) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NITRO_PORT: String(port),
      NITRO_HOST: "127.0.0.1",
      HOST: "127.0.0.1",
      // Node closes idle keep-alive sockets after 5s; an exam has 5-30s think
      // times, so the next request would land on a closed socket.
      // NOTE: NODE_OPTIONS is parsed with backslash escapes, so the path must
      // use forward slashes.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require "${path.join(ROOT, "scripts", "node-keep-alive.cjs").replace(/\\/g, "/")}"`.trim(),
    },
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code) => console.log(`[qa500:serve] :${port} exited (${code})`));
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
