#!/usr/bin/env node
/**
 * QA-500 resource monitor — samples the machine + staging DB during a run.
 *
 *   node tests/qa500/monitor.mjs --duration=2400 --interval=5
 *
 * Writes:
 *   tests/.artifacts/qa500/monitor.csv        (timestamp,cpu%,rss,db counts…)
 *   tests/.artifacts/qa500/monitor-summary.json (peaks + averages for the report)
 *
 * What is measured (Windows host, single dev-server process):
 *   - system CPU % (all cores)
 *   - node.exe RSS + CPU seconds (the Vite dev server doing SSR + scoring)
 *   - k6.exe RSS + CPU seconds (the load generator, same machine caveat)
 *   - staging DB row counts: in_progress / completed / responses / results
 *     (SQLite file DB — "DB connections" is N/A for a single-writer file DB;
 *      write-queue latency is visible in response times instead)
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { ART_DIR, openDb } from "./lib/qa500.mjs";

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
}
const DURATION_S = Number(arg("duration", 2400));
const INTERVAL_S = Number(arg("interval", 5));

fs.mkdirSync(ART_DIR, { recursive: true });
const csvPath = path.join(ART_DIR, "monitor.csv");
const summaryPath = path.join(ART_DIR, "monitor-summary.json");

function ps(script) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
}

const db = await openDb();
const samples = [];
let headerWritten = false;

async function sample() {
  const ts = new Date().toISOString();
  // 1. processes
  const procJson = await ps(
    "Get-Process node,k6 -ErrorAction SilentlyContinue | Select-Object ProcessName,@{n='CPU';e={[math]::Round($_.CPU,1)}},@{n='RSS_MB';e={[math]::Round($_.WS/1MB,0)}} | ConvertTo-Json -Compress",
  );
  let nodeRss = 0;
  let nodeCpu = 0;
  let k6Rss = 0;
  let k6Cpu = 0;
  try {
    const arr = procJson ? JSON.parse(procJson) : [];
    for (const p of Array.isArray(arr) ? arr : arr ? [arr] : []) {
      if (p.ProcessName === "node") {
        nodeRss += Number(p.RSS_MB ?? 0);
        nodeCpu += Number(p.CPU ?? 0);
      }
      if (p.ProcessName === "k6") {
        k6Rss += Number(p.RSS_MB ?? 0);
        k6Cpu += Number(p.CPU ?? 0);
      }
    }
  } catch {
    /* ignore parse errors */
  }

  // 2. system CPU
  let sysCpu = "";
  const counter = await ps(
    "try { [math]::Round((Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue,1) } catch { '' }",
  );
  if (counter !== null && counter !== "") sysCpu = counter;

  // 3. DB counts (tolerate transient SQLITE_BUSY during heavy writes)
  let dbi = {};
  try {
    const q = async (sql) => {
      const r = await db.execute(sql);
      return Number(Object.values(r.rows[0] ?? {})[0] ?? 0);
    };
    dbi = {
      resp: await q("SELECT COUNT(*) FROM responses"),
      results: await q("SELECT COUNT(*) FROM results"),
      completed: await q("SELECT COUNT(*) FROM participants WHERE status='completed'"),
      in_progress: await q("SELECT COUNT(*) FROM participants WHERE status='in_progress'"),
    };
  } catch {
    dbi = { resp: "", results: "", completed: "", in_progress: "" };
  }

  const row = { ts, sysCpu, nodeRss, nodeCpu, k6Rss, k6Cpu, ...dbi };
  samples.push(row);
  if (!headerWritten) {
    fs.writeFileSync(csvPath, Object.keys(row).join(",") + "\n");
    headerWritten = true;
  }
  fs.appendFileSync(csvPath, Object.values(row).join(",") + "\n");
  process.stdout.write(
    `[qa500:monitor] ${ts} cpu=${sysCpu}% nodeRSS=${nodeRss}MB k6RSS=${k6Rss}MB ` +
      `resp=${dbi.resp} completed=${dbi.completed} in_progress=${dbi.in_progress}\n`,
  );
}

console.log(`[qa500:monitor] sampling every ${INTERVAL_S}s for up to ${DURATION_S}s -> ${csvPath}`);
await sample();
const timer = setInterval(() => void sample(), INTERVAL_S * 1000);
setTimeout(() => process.emit("SIGTERM"), DURATION_S * 1000);

process.on("SIGTERM", () => {
  clearInterval(timer);
  const stat = (k) => {
    const vals = samples.map((s) => Number(s[k])).filter((n) => Number.isFinite(n) && !Number.isNaN(n));
    if (!vals.length) return null;
    return {
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
    };
  };
  const summary = {
    samples: samples.length,
    from: samples[0]?.ts,
    to: samples[samples.length - 1]?.ts,
    systemCpuPercent: stat("sysCpu"),
    nodeRssMb: stat("nodeRss"),
    nodeCpuSeconds: stat("nodeCpu"),
    k6RssMb: stat("k6Rss"),
    dbResponses: stat("resp"),
    dbResults: stat("results"),
    dbCompleted: stat("completed"),
    dbInProgress: stat("in_progress"),
    note:
      "SQLite file DB = single writer (the app instances share one file, WAL " +
      "mode + 5s busy timeout). node.exe = the app instances under test " +
      "(production build) plus any dev server running on the same box; " +
      "k6.exe = the load generator on the same host (its RSS dominates).",
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`[qa500:monitor] DONE — ${samples.length} samples, summary: ${summaryPath}`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
});
