/**
 * Node keep-alive hardening (preload).
 *
 *   node --require ./scripts/node-keep-alive.cjs .output/server/index.mjs
 *   # or:  NODE_OPTIONS="--require ./scripts/node-keep-alive.cjs" node .output/server/index.mjs
 *
 * WHY: Node's HTTP server closes an idle keep-alive socket after 5 seconds
 * (`server.keepAliveTimeout = 5000`). During an exam a student thinks for
 * 5-30 seconds between answers, so the next request routinely lands on a
 * socket the server has already closed. The client then sees
 * "An existing connection was forcibly closed by the remote host" and the
 * request is lost. Browsers retry such a request, API clients (and the k6
 * load test) do not - during the QA-500 run this silently ate ~0.3% of the
 * answer writes.
 *
 * Node loads the Nitro app lazily (the first request imports it), so the
 * server is already listening by the time any app module runs. A preload
 * runs before the entry point and therefore before the server is created.
 *
 * 65s is the classic nginx `keepalive_timeout` value and comfortably covers
 * the longest think time plus a slow request.
 */
"use strict";

const http = require("node:http");

const KEEP_ALIVE_TIMEOUT_MS = 65_000;

if (!http.__prarambhKeepAlivePatched) {
  const original = http.createServer;
  http.createServer = function (...args) {
    const server = original.apply(this, args);
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;
    return server;
  };
  Object.defineProperty(http, "__prarambhKeepAlivePatched", { value: true });
}

module.exports = { KEEP_ALIVE_TIMEOUT_MS };
