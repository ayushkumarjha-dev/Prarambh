/**
 * Minimal HTTP client for TanStack Start server functions (Phase 1).
 *
 * Protocol, reverse-engineered from @tanstack/start-client-core:
 *   POST {base}/_serverFn/{fnId}
 *   headers: x-tsr-serverFn: true, content-type: application/json,
 *            accept: application/json   (JSON instead of framed, for parsing)
 *   body:    seroval cross-JSON of { data }   (NOT plain JSON)
 *   response: x-tss-serialized: true + seroval cross-JSON of the return
 *             value; thrown server errors come back as serialized Error
 *             instances (HTTP 200 or 500 depending on the error path).
 *
 * fnId is deterministic:
 *   base64url(JSON.stringify({ file, export: `${name}_createServerFn_handler` }))
 *
 * Note for k6: bodies are seroval-encoded — precompute payload strings with
 * tests/load/gen-payloads.mjs instead of hand-building JSON in k6.
 */
import { toJSONAsync, fromCrossJSON } from "seroval";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Same plugins the real client uses (`getDefaultSerovalPlugins()` in
// @tanstack/start-client-core). ShallowErrorPlugin deserializes the
// `$TSR/Error` nodes the server sends for thrown errors — with an empty
// plugin list fromCrossJSON throws "Seroval Error (step: 3)".
import { defaultSerovalPlugins } from "@tanstack/router-core/ssr/client";

export const SERVER_FN_FILES = {
  exam: "/src/lib/exam.functions.ts?tss-serverfn-split",
  admin: "/src/lib/admin.functions.ts?tss-serverfn-split",
  auth: "/src/lib/auth.functions.ts?tss-serverfn-split",
};

export function fnId(file, exportName) {
  return Buffer.from(
    JSON.stringify({ file, export: `${exportName}_createServerFn_handler` }),
    "utf8",
  ).toString("base64url");
}

/** Plain (non-split) provider module paths — what a browser GETs when a page imports them. */
export const PROVIDER_MODULES = Object.values(SERVER_FN_FILES).map((f) => f.split("?")[0]);

/**
 * Production builds register server functions under SHA-256 ids, not the dev
 * base64url of {file, export}. Read that mapping straight from the built
 * resolver so API-style clients (smoke, k6 payloads) can hit `qa500:serve`.
 */
export function readProdFnIds(buildDir = fileURLToPath(new URL("../../.output/server", import.meta.url))) {
  if (!fs.existsSync(buildDir)) {
    throw new Error(`no production build at ${buildDir} — run: npm run qa500:build`);
  }
  const resolver = fs
    .readdirSync(buildDir)
    .find((f) => f.startsWith("__23tanstack-start-server-fn-resolver") && f.endsWith(".mjs"));
  if (!resolver) throw new Error(`server-fn resolver not found in ${buildDir}`);
  const src = fs.readFileSync(path.join(buildDir, resolver), "utf8");
  const map = {};
  for (const m of src.matchAll(
    /"([0-9a-f]{64})":\s*\{\s*functionName:\s*"([A-Za-z0-9_]+)_createServerFn_handler"/g,
  )) {
    map[m[2]] = m[1];
  }
  if (!Object.keys(map).length) throw new Error("no server-fn ids parsed from the production build");
  return map;
}

/** Switch fn-id resolution to a fixed map (production build). */
export function useFnIds(map) {
  idOverride = map;
}

let idOverride = null;

function resolveFnId(file, name) {
  return idOverride?.[name] ?? fnId(file, name);
}

/**
 * Register the provider files' server fns on a running dev server.
 *
 * TanStack Start only inserts a server fn into its dev lookup table
 * (serverFnsById, in-memory) when some environment COMPILES the plain
 * provider module — exactly what a browser does the moment a page imports
 * it. Pure API-style clients (smoke, k6, e2e API calls) never load a page,
 * so without this warm-up the server answers 500 "Invalid server function
 * ID". These GETs perform the identical client transform a page load would.
 * Idempotent and cheap — call it from every entry point, and again after a
 * dev-server restart (the table does not survive a restart).
 */
export async function warmUpServerFns(base) {
  // A production build has no Vite module endpoints — the functions are
  // registered at build time. Opt in with PROD=1 when targeting `qa500:serve`.
  if ((process.env.PROD || "0") === "1") return;
  for (const path of PROVIDER_MODULES) {
    const res = await fetch(new URL(path, base), {
      headers: { accept: "*/*" },
    });
    if (!res.ok) throw new Error(`server-fn warm-up ${path} failed: HTTP ${res.status}`);
    await res.text(); // drain the body
  }
}

/** Serialize a `data` payload exactly like the TSS client does (for k6 precompute too). */
export async function serializeFnData(data) {
  return JSON.stringify(await toJSONAsync({ data }, { plugins: [] }));
}

/**
 * Call a server function over HTTP.
 * Resolves to { status, ok, result, error, text } — `error` is a real Error
 * instance when the server function threw; `result` is the returned value.
 */
export async function callServerFn(base, options) {
  const {
    fn,
    data,
    file = SERVER_FN_FILES.exam,
    method = "POST",
    headers = {},
    signal,
    token,
  } = options;
  const url = `${String(base).replace(/\/+$/, "")}/_serverFn/${resolveFnId(file, fn)}`;
  const origin = new URL(url).origin;
  const h = {
    "x-tsr-serverFn": "true",
    "content-type": "application/json",
    accept: "application/json",
    // TSS default CSRF middleware rejects requests without a same-origin
    // signal (Sec-Fetch-Site / Origin / Referer) with 403 "Forbidden".
    "sec-fetch-site": "same-origin",
    origin,
    ...headers,
  };
  if (token) h.authorization = `Bearer ${token}`;
  const body = data === undefined ? undefined : await serializeFnData(data);
  const res = await fetch(url, { method, headers: h, body, signal });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  let result = null;
  let error = null;
  if (res.headers.get("x-tss-serialized") && ct.includes("application/json")) {
    let de;
    try {
      de = fromCrossJSON(JSON.parse(text), { plugins: defaultSerovalPlugins });
    } catch (e) {
      error = e;
      de = undefined;
    }
    if (de instanceof Error) error = de;
    else if (de && typeof de === "object" && "result" in de) {
      // TSS server-fn response envelope: { result, error, context }.
      if (de.error) error = de.error instanceof Error ? de.error : new Error(String(de.error?.message ?? de.error));
      result = de.result;
    } else result = de;
  } else if (ct.includes("application/json")) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && j.error) error = new Error(String(j.error));
      else result = j;
    } catch {
      result = text;
    }
  } else {
    result = text;
  }
  return { status: res.status, ok: res.ok, result, error, text, headers: res.headers };
}
