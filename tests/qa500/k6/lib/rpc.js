/**
 * QA-500 k6 shared library — RPC calls, seroval-aware assertions, summaries.
 *
 * Wire protocol (TanStack Start server functions):
 *   POST {base}/_serverFn/{fnId}  with x-tsr-serverFn + same-origin signals;
 *   bodies are PRECOMPUTED seroval cross-JSON (tests/qa500/gen-payloads.mjs).
 * Responses are seroval cross-JSON envelopes {result,error,context}:
 *   - success: envelope without an error node
 *   - thrown server error: embedded {"c":"$TSR/Error"} node with .message
 */
import http from "k6/http";
import { sleep } from "k6";
import exec from "k6/execution";

export const CSRF_HEADERS = {
  "x-tsr-serverFn": "true",
  "content-type": "application/json",
  accept: "application/json",
  "sec-fetch-site": "same-origin",
};

export function baseUrl() {
  const list = (__ENV.BASE_URLS || __ENV.BASE_URL || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 1) return list[0];
  // Multi-instance run (B7): pin each VU to one instance, like a sticky LB.
  return list[__VU % list.length];
}

export function rpc(fnId, body, name) {
  const url = `${baseUrl()}/_serverFn/${fnId}`;
  const headers = Object.assign({}, CSRF_HEADERS, { origin: baseUrl() });
  const res = http.post(url, body, { headers, tags: { name: name || "rpc", fn: fnId.slice(0, 10) } });
  const out = {
    status: res.status,
    body: res.body || "",
    serialized: res.headers["X-Tss-Serialized"] === "true",
    ok: res.status === 200 && res.headers["X-Tss-Serialized"] === "true",
  };
  // DEBUG_BODY=1 prints the first failing response of every VU (the body holds
  // the server error, e.g. "$TSR/Error" with the message). Without it a failed
  // check is indistinguishable from a slow one.
  if ((__ENV.DEBUG_BODY || "0") === "1" && dbgSeen < 3 && (!out.ok || out.body.indexOf('"$TSR/Error"') !== -1)) {
    dbgSeen++;
    console.log(`[dbg] ${name || "rpc"} status=${out.status} body=${out.body.slice(0, 300)}`);
  }
  return out;
}

// Per-VU counter (each k6 VU has its own JS runtime).
let dbgSeen = 0;

/**
 * Register the provider files' server fns — MUST run from setup() before
 * any VU makes an RPC call.
 *
 * TanStack Start only inserts a server fn into its dev lookup table
 * (serverFnsById, in-memory) when some environment COMPILES the plain
 * provider module — what a browser does as soon as a page imports it. k6
 * never loads a page, so without this warm-up every RPC 500s with
 * "Invalid server function ID". The GETs below run the identical client
 * transform a page load would. Also call this AFTER a dev-server restart:
 * the table lives in memory and starts empty on a fresh server.
 */
export function warmUp() {
  const paths = [
    "/src/lib/exam.functions.ts",
    "/src/lib/auth.functions.ts",
    "/src/lib/admin.functions.ts",
  ];
  for (const p of paths) {
    const res = http.get(`${baseUrl()}${p}`, { tags: { name: "warmup" } });
    if (res.status !== 200) {
      // A production build has no Vite module endpoints — server functions are
      // registered at build time, so there is nothing to warm. Opt in with
      // -e PROD=1 when measuring the built app (B7).
      if ((__ENV.PROD || "0") === "1") continue;
      throw new Error(`warm-up ${p} -> HTTP ${res.status}`);
    }
  }
}

/**
 * warmUp() + proof that a real server fn is callable.
 *
 * On an idle/fresh dev server the module GET can return 200 *before* the
 * plugin has finished inserting the fn into its in-memory lookup table, so a
 * VU's very first RPC can still 500 with "Invalid server function ID".
 * Probe an actual fn until the envelope no longer says that, then return.
 * Any other outcome (success, or a product-level error) proves registration.
 */
export function warmUpVerified(fnId, body) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    warmUp();
    const r = rpc(fnId, body, "warmup-verify");
    if (!(threw(r, "Invalid server function ID"))) return attempt;
    sleep(2);
  }
  throw new Error("warm-up verification failed after 10 attempts (server fns not registered)");
}

/** True when the envelope carries a thrown server Error (optionally with message). */
export function threw(r, message) {
  if (r.status !== 200 || r.body.indexOf('"$TSR/Error"') === -1) return false;
  return message ? r.body.indexOf(message) !== -1 : true;
}

/** True when the server function RETURNED a value (no thrown error). */
export function returned(r) {
  return r.ok && r.body.indexOf('"$TSR/Error"') === -1;
}

/** Human think time between questions (seconds). */
export function thinkTime(minSec, maxSec) {
  sleep(minSec + Math.random() * (maxSec - minSec));
}

function parseDur(s, fallbackMs) {
  if (!s) return fallbackMs;
  const m = String(s).match(/^(\d+)(s|m)?$/);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  return (m[2] === "m" ? n * 60 : n) * 1000;
}

/**
 * Park a finished VU until the scenario is over (prevents a VU from looping
 * back into a second exam attempt — every student has exactly one). The park
 * window intentionally overshoots the stage timeline: k6 stops the VU at
 * gracefulStop, which is harmless, whereas waking up early would re-login an
 * already-submitted student and pollute the error rate.
 */
export function parkUntilScenarioEnd(graceMs) {
  const end =
    exec.scenario.startTime +
    parseDur(__ENV.RAMP_UP, 120000) +
    parseDur(__ENV.HOLD, 1800000) +
    parseDur(__ENV.RAMP_DOWN, 60000) +
    parseDur(__ENV.SPIKE_DURATION, 10000) +
    (graceMs || 120000);
  while (Date.now() < end) sleep(30);
}

function pick(values, keys) {
  const out = {};
  for (const k of keys) if (values && values[k] !== undefined) out[k] = values[k];
  return out;
}

/**
 * handleSummary: writes a compact JSON report into tests/.artifacts/qa500/
 * (relative to the k6 working directory — run k6 from the repo root) and a
 * short human-readable stdout block.
 */
export function makeSummary(fileName) {
  return function handleSummary(data) {
    const m = data.metrics || {};
    const compact = {
      root_group: data.root_group,
      http_req_duration: pick(m.http_req_duration && m.http_req_duration.values, [
        "avg", "med", "p(90)", "p(95)", "p(99)", "max", "min",
      ]),
      http_req_failed: pick(m.http_req_failed && m.http_req_failed.values, ["rate", "passes", "fails"]),
      http_reqs: pick(m.http_reqs && m.http_reqs.values, ["count"]),
      iterations: pick(m.iterations && m.iterations.values, ["count", "fails", "passes"]),
      iterations_rate: pick(m.iterations_rate && m.iterations_rate.values, ["value"]),
      checks: pick(m.checks && m.checks.values, ["rate", "passes", "fails"]),
      errors: pick(m.errors && m.errors.values, ["rate", "passes", "fails"]),
      login_duration: pick(m.login_duration && m.login_duration.values, ["avg", "p(95)", "p(99)", "max"]),
      state_duration: pick(m.state_duration && m.state_duration.values, ["avg", "p(95)", "p(99)", "max"]),
      save_duration: pick(m.save_duration && m.save_duration.values, ["avg", "p(95)", "p(99)", "max"]),
      submit_duration: pick(m.submit_duration && m.submit_duration.values, ["avg", "p(95)", "p(99)", "max"]),
      thresholds_failed: data.thresholds || {},
    };
    // every custom metric (Counter/Rate/Gauge defined by the scenario)
    const known = new Set(Object.keys(compact));
    for (const [name, metric] of Object.entries(m)) {
      if (known.has(name) || !metric || !metric.values) continue;
      if (name.startsWith("http_req") || name.startsWith("data_") || name.startsWith("vus") ||
          name === "dropped_iterations" || name === "iterations" || name === "iterations_rate" ||
          name === "checks" || name === "group_duration" || name === "session_duration") continue;
      compact[name] = pick(metric.values, ["count", "rate", "value", "passes", "fails"]);
      if (Object.keys(compact[name]).length === 0) compact[name] = pick(metric.values, ["avg", "med", "p(95)", "max"]);
    }
    const lines = [
      `http_req_duration p95=${compact.http_req_duration["p(95)"]}ms p99=${compact.http_req_duration["p(99)"]}ms`,
      `http_req_failed rate=${compact.http_req_failed.rate}  iterations=${compact.iterations.count}`,
      `checks pass-rate=${compact.checks.rate}  errors rate=${compact.errors.rate}`,
      ...Object.entries(compact)
        .filter(([k]) => !["root_group", "http_req_duration", "http_req_failed", "http_reqs", "iterations", "iterations_rate", "checks", "errors", "login_duration", "state_duration", "save_duration", "submit_duration", "thresholds_failed"].includes(k))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`),
      `thresholds failed: ${JSON.stringify(data.thresholds)}`,
    ];
    return {
      [`tests/.artifacts/qa500/${fileName}`]: JSON.stringify(compact, null, 2),
      stdout: lines.join("\n") + "\n",
    };
  };
}
