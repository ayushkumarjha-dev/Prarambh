# QA-500 — 500 concurrent live users test plan (Prarambh)

Complete QA + performance suite for the online examination app: **500 students
taking a 30-question / 30-minute exam at the same time**, strict anti-cheating
and auto-submit verification, edge/failure cases, and a generated report.
Everything runs against **staging only** (`.env.test` → local test DB + the
`dev:test` server). Production `.env` is never touched — safety guard in
`tests/lib/env.mjs` refuses to start otherwise.

> **Do not run any of this against production.** Cleanup removes only
> `qa500-*`-marked data (slugs `qa500-%`, `group_name LIKE 'qa500%'`).

---

## 1. Test data

| What | Details |
|---|---|
| Exam (load) | `qa500-live` — 30 MCQ, 30 minutes, status `live`, window −15m…+6h |
| Exam (e2e) | `qa500-e2e` — 5 MCQ, 10 minutes (Playwright specs) |
| Load students | `test001@example.com … test500@example.com`, password **`Qa500!Pass123`**, `group_name=qa500` |
| E2E students | `e2e001…e2e012@example.com`, password **`E2e!Pass1234`**, `group_name=qa500-e2e` |
| Smoke student | `smoke001@example.com`, password `E2e!Pass1234` |
| Correct answers | deterministic: question *q* → `["A","B","C","D"][(q-1)%4]` (q1 → A) |

Credentials file: `tests/.artifacts/qa500/seed-credentials.json` (gitignored,
never printed/committed).

> **Fixtures expire (6h).** Logins are refused once `ends_at` has passed, while
> mid-exam resumes (state/submit) still work — a stale window gives confusing
> false negatives (e.g. recovery "pre-outage login 0/10"). Refresh before a
> later session: `node tests/qa500/refresh-window.mjs` (or re-seed).

## 2. Prerequisites

```powershell
# once: staging DB created + migrated
npm run db:migrate         # applies migrations/ to .env.test's file DB

node tests/qa500/seed.mjs            # 500+ participants, 2 exams (bcrypt ~1 min)
node tests/qa500/gen-payloads.mjs    # pre-serialize every k6 request body

npm run dev:test                     # staging server (Resend mock + vite :5173)
# k6: download v2.3.0 from https://github.com/grafana/k6/releases into
# tools/k6-v2.3.0-windows-amd64/ (tools/ is gitignored — 64MB binary)
```

Optional dry-runs: `node tests/qa500/seed.mjs --dry-run`,
`node tests/qa500/cleanup.mjs --dry-run`.

## 3. Load tests (k6) — run from the repo root

```powershell
$k6 = "tools\k6-v2.3.0-windows-amd64\k6.exe"
$base = "http://localhost:5173"

# A. MAIN: 0→500 users / 2m, hold 30m, ramp down 1m, human think time 5–30s/question
node tests\qa500\monitor.mjs --duration=2400 --interval=5        # CPU/RAM/DB sampling (separate shell)
& $k6 run tests\qa500\k6\scenario-load-500.js -e BASE_URL=$base --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
#    knobs: -e USER_COUNT=500 -e RAMP_UP=2m -e HOLD=30m -e RAMP_DOWN=1m -e THINK_MIN=5 -e THINK_MAX=30

# B. LOGIN SPIKE: 500 logins within 10s   (run on fresh/not_started students)
& $k6 run tests\qa500\k6\scenario-login-spike.js -e BASE_URL=$base --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
#    capacity curve (gentler arrival under the dev-server ceiling):
#    -e SPIKE_RATE=10 -e SPIKE_DURATION=50s

# C. SUBMIT SPIKE: 500 submits within 10s (participants pre-started w/ 30 answers)
node tests\qa500\reset-participants.mjs --mode=mid-exam
& $k6 run tests\qa500\k6\scenario-submit-spike.js -e BASE_URL=$base --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"

# D. RECOVERY: server restart mid-exam (10 students, 3-minute window)
node tests\qa500\reset-participants.mjs --mode=mid-exam
& $k6 run tests\qa500\k6\scenario-recovery.js -e BASE_URL=$base
#    while it runs (t≈40-80s): restart the dev server (Ctrl+C → npm run dev:test)
```

> All API-style clients (k6 `setup()`, `smoke.mjs`, the e2e `apiCall` helper)
> warm up automatically: TanStack registers server functions only when an
> environment compiles the plain `src/lib/*.functions.ts` provider module —
> exactly what a browser does when a page loads. A raw API client must GET
> those modules once first (`warmUpServerFns` / `warmUp()`), and again after
> any dev-server restart (the registry is in-memory).

Reset between scenarios:

```powershell
node tests\qa500\reset-participants.mjs --mode=fresh     # clean slate for the main run
```

Summaries land in `tests/.artifacts/qa500/k6-*-summary.json`
(k6 exits code 99 when a threshold fails — that is data, not a crash).

**Pass criteria (encoded as k6 thresholds):** error rate < 1 %,
p95 < 2 s, p99 < 4 s, checks pass-rate ≥ 99 %, zero lost answers, zero
duplicate submissions, no double scoring (verified after the run), timer
server-authoritative (verified in e2e).

## 4. Verification after a run

```powershell
node tests\qa500\verify-results.mjs --phase=load     # V1..V6 invariants → verify-load.json
node tests\qa500\verify-results.mjs --phase=spike    # after the submit spike
```

Checks: every completed attempt has all 30 responses (V1), exactly one results
row + submit meta (V2), `sum(marks_awarded) == results.total_marks` (V3),
independent re-grade matches stored totals (V4), no locked/failed accounts
(V5), no stray violations (V6). Non-zero exit on any failure.

## 5. Browser tests (Playwright)

```powershell
npm run qa500:e2e                 # all 5 projects (chromium/firefox/webkit + Pixel 7 + iPhone 13)
npm run qa500:e2e -- --project=desktop-chromium        # one project
npm run qa500:e2e -- tests/qa500/e2e/proctoring.spec.ts  # one spec
npm run qa500:config-check        # MAX_VIOLATIONS=2 proof on an isolated port
```

Specs (each student is reset before every test):

| Spec | Covers |
|---|---|
| `proctoring.spec.ts` (desktop) | fullscreen lock, Esc/exit-fullscreen violation, 3-strikes auto-submit with answers graded, resize/split-screen violation, window-narrowing never ejects the exam (B9), devtools/right-click/copy/print interception |
| `mobile.spec.ts` (phones) | fairness notice, no-fullscreen fallback, app-switch/screen-lock violations, auto-submit, split-screen + orientation violations |
| `autosubmit.spec.ts` | timer zero (server clock), manual submit + confirmation popup, post-submit lockdown (refresh/back/2nd device/API) + idempotent re-submit |
| `edge-cases.spec.ts` | refresh mid-exam (0 violations, B8), short offline, 30s offline outbox (B2), offline submit queue (B1), slow 3G (CDP), dual-device token rotation (B3) |
| `violation-limit.spec.ts` | auto-submit happens on exactly the server-configured `MAX_VIOLATIONS` (B4) — runs once, in desktop Chromium |

> Runs are headless by default and headless Chromium supports the Fullscreen
> API, so proctoring tests are fully automated. Avoid clicking inside a
> `--headed` window while a run is in progress: the detector listens to real
> `blur`/clicks and a stray click can answer questions or add violations.

## 6. Report

```powershell
node tests\qa500\report\generate-report.mjs   # → tests/qa500/REPORT.md
```

Merges k6 summaries + DB verification + resource monitor + Playwright results
into the results table, metrics tables, defect list (severity + repro + fix)
and the final **Ready / Not ready** verdict.

## 6b. Production-build throughput (B7)

The dev server is a single module-transforming process, so its login ceiling is
a harness limit, not the app's. The deployable ceiling is bcrypt: the 500 test
participants use cost-10 hashes, and one compare costs ~62 ms of pure CPU on
this host (~16 logins/s per process, no matter how it is served). To measure
the deployable shape:

```powershell
npm run qa500:build               # Nitro node-server build (.output/server)
$env:QA500_PROD_WORKERS="4"; npm run qa500:serve   # 4 instances on :5180-:5183

# payloads must carry the BUILD's server-fn ids (SHA-256, not the dev ones)
node tests\qa500\gen-payloads.mjs --prod

& $k6 run tests\qa500\k6\scenario-login-spike.js -e BASE_URLS=http://localhost:5180,http://localhost:5181,http://localhost:5182,http://localhost:5183 -e PROD=1 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
& $k6 run tests\qa500\k6\scenario-load-500.js    -e BASE_URLS=http://localhost:5180,http://localhost:5181,http://localhost:5182,http://localhost:5183 -e PROD=1 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
```

**Why separate instances, not `node:cluster`:** Nitro's node-server calls
`listen({ exclusive: true })`, so clustered workers each bind their own socket;
on Windows the OS then sends every connection to one worker and the others sit
idle (measured: 4 workers ≈ 1 worker). `qa500:serve` therefore starts N
independent processes on consecutive ports and k6 pins each VU to one of them
(`BASE_URLS`, round-robin) — the same shape as N app servers behind a load
balancer, which is how the app is deployed.

`PROD=1` tells k6 and the smoke test to skip the Vite module warm-up (there are
no module endpoints in a build). The build uses `--mode test`, so it is still
bound to `.env.test` and `assertNotProduction()` still guards the launch.
After a rebuild, re-run `gen-payloads --prod`: the server-fn ids change with
the bundle.

**Keep-alive preload.** The instances are started with
`NODE_OPTIONS="--require scripts/node-keep-alive.cjs"`, which raises Node's
5-second idle keep-alive window to 65 s. Without it a student who thinks for
more than 5 seconds sends the next request on a socket the server has already
closed ("connection forcibly closed") and the write is lost — browsers retry,
API clients do not (bug B11). A production Node deployment should load the
same preload, or put the app behind a proxy with `keepalive_timeout 65s`.

**Sizing the login burst.** `qa500:serve` writes `prod-deployment.json` (and
prints the k6 command) so the report can describe the measured shape. On the
staging host (6 cores / 12 threads, k6 co-located), 4 instances at the 50
logins/s spike give p95 ≈ 8 s with 0 application errors — the burst is CPU-bound
on bcrypt, not broken. Budget `logins_per_s × 0.062` cores for hashing alone:
~3 cores for 50 logins/s, plus headroom, i.e. 6–8 instances on dedicated
hardware. Spreading the same 500 logins over 40 s (12.5/s) passes comfortably.

### 6c. Debugging a failed k6 run

A server function that throws answers **HTTP 200** with a serialized
`{"$TSR/Error":{message}}` envelope, so k6 reports *no* transport error while
the check fails. Print the first failing responses per VU with:

```powershell
& $k6 run tests/qa500/k6/scenario-load-500.js -e BASE_URLS=... -e PROD=1 -e DEBUG_BODY=1
# [dbg] save status=200 body={..."message":{"t":1,"s":"SQLITE_BUSY: database is locked"}...}
```

`DEBUG_BODY=1` is the fastest way to see the real error behind a failing
check (it is how bug B10 was found).

## 7. Cleanup (removes ALL qa500 test data)

```powershell
node tests\qa500\cleanup.mjs            # DB rows + local artifacts
node tests\qa500\cleanup.mjs --dry-run  # counts only
```

## 8. Recommended full sequence (fresh machine)

```powershell
npm run db:migrate
node tests/qa500/seed.mjs
node tests/qa500/gen-payloads.mjs
npm run dev:test                         # shell 1 (stays up)
node tests/qa500/monitor.mjs --duration=3000   # shell 2 (start before the load run)

# smoke: one manual attempt via the API
node tests/qa500/smoke.mjs

# spikes first (fresh students)
& $k6 run tests\qa500\k6\scenario-login-spike.js -e BASE_URL=http://localhost:5173 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
node tests\qa500\reset-participants.mjs --mode=mid-exam
& $k6 run tests\qa500\k6\scenario-submit-spike.js -e BASE_URL=http://localhost:5173 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
node tests\qa500\verify-results.mjs --phase=spike

# main 30-minute run
node tests\qa500\reset-participants.mjs --mode=fresh
& $k6 run tests\qa500\k6\scenario-load-500.js -e BASE_URL=http://localhost:5173 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
node tests\qa500\verify-results.mjs --phase=load

# browsers
npm run qa500:e2e

# report
node tests\qa500\report\generate-report.mjs
```

## 9. Known limitations of this environment

- **Dev server by default** — the functional e2e + data-integrity runs use
  `vite dev`. Section 6b measures the built app across N independent instances,
  which is the deployment-shaped number used for the throughput verdict.
- **Local file DB** — SQLite is a single-writer queue; write contention here is
  pessimistic vs. Turso cloud, read latency is optimistic. The test DB runs in
  WAL mode and the app creates its libSQL client with `timeout: 5000`, so the
  driver applies the busy timeout to **every** connection of the pool (a
  `PRAGMA busy_timeout` only reaches one connection — that was bug B10, and it
  cost 132 of 500 examinees their attempt in the first 30-minute run).
- **One machine** runs server + k6 + monitor (CPU contention inflates p95).
- **Emulated devices** — for physical iOS/Android use BrowserStack/LambdaTest;
  iPhone Safari has no Fullscreen API (app falls back to no-lock + tab-switch
  detection by design).
- **Not automatable here:** battery-saver/background throttling and real
  call/notification shade on physical phones — manual checklist: lock screen
  mid-exam (expect violation + auto-submit), battery-saver timer throttling
  (server timer must still auto-submit), split-screen on a real Android (blur
  path should catch it).
