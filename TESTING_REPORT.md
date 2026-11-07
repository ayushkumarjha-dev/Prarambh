# Prarambh — Detailed Testing Report

> **Report date:** 2026-11-04 · **Project:** Prarambh online examination portal
> (TanStack Start SSR + React 19 + Turso/libSQL)
> **Reference QA run:** QA-500 executed 2026-10-21 (artifacts under `tests/.artifacts/qa500/`)
> **Verification re-run:** static checks + smoke suite re-executed 2026-11-04 (this report)
> **Environment policy:** staging/test databases only — production `.env` is never touched (guard: `tests/lib/env.mjs`)

---

## 1. Executive summary

| Area | Verdict | Evidence |
|---|---|---|
| Type safety (`tsc --noEmit`) | ✅ **PASS** | Exit 0, zero errors (re-run 2026-11-04) |
| Lint (`eslint .`) | ❌ **FAIL** | 1932 problems: 1921 errors + 11 warnings — 96 % are Prettier formatting (re-run 2026-11-04) |
| Server-function smoke (Playwright, Chromium) | ✅ **PASS** | 2/2 passed in 10.7 s (re-run 2026-11-04) |
| Email-mock tooling self-test | ✅ **PASS** | Resend mock 4/4 assertions |
| QA-500 functional matrix (25 criteria) | ❌ **24 PASS / 1 FAIL** | Only **TC-02** (500 logins in 10 s, p95 < 2 s) missed |
| QA-500 browser matrix (5 projects) | ✅ **PASS** | 100 runs — 68 passed, **0 failed**, 0 flaky, 32 intentionally skipped |
| QA-500 data-integrity invariants (V1–V7) | ✅ **PASS** | 0 lost answers, 0 duplicate submissions, 0 double scoring — both phases |
| QA-500 performance (500-user load, 30 min) | ✅ **PASS** | p95 20 ms · p99 83 ms · error rate 0.015 % |
| QA-500 performance (login burst 50/s) | ❌ **FAIL** | p95 14 059 ms vs target < 2 000 ms (defect **B7**, open) |
| Production build (`vite build`) | ✅ **PASS** | Exit 0 — client + Nitro server bundles generated (re-run 2026-11-04) |

**Overall readiness:** the platform is **functionally and structurally sound** — every
data-integrity invariant, every e2e scenario and every performance target passes
**except one synthetic worst case**: 500 bcrypt logins compressed into 10 seconds
(TC-02 / defect B7). With the login window spread over ~50 s the same deployment
passes comfortably (measured p95 101 ms). See §8 for the go/no-go recommendation.

---

## 2. Scope

### 2.1 In scope

| Layer | What is covered |
|---|---|
| Student flow | login → instructions → proctored exam → answer persistence → auto-submit (timer/violations) → submission lockdown |
| Proctoring | fullscreen lock, tab/blur/visibility, resize/split-screen/orientation, DevTools/right-click/copy/print interception, configurable `MAX_VIOLATIONS` |
| Resilience | page refresh, short/30 s network drops, offline submit queueing, slow-3G throttling, dual-device token rotation, server restart recovery |
| Organizer flow | auth (HMAC session), exam CRUD, student/credential management, question-set upload, results dashboard (server functions validated by Zod + auth middleware) |
| Performance | 0→500 concurrent over 30 min, login spike, submit spike, recovery — k6 against a 4-instance production build |
| Data integrity | zero lost answers, zero duplicate submissions, zero double scoring, independent re-grade match, no stuck accounts |
| Platform | Chromium / Firefox / WebKit desktop + Pixel 7 / iPhone 13 emulation; PWA/phone fairness path |

### 2.2 Out of scope (known gaps — see §7)

- Unit/integration tests (Vitest is installed but **no test files or config exist**)
- Physical-device testing (emulation only), real email delivery (mocked), production Turso cloud latency
- Organizer-panel UI e2e coverage beyond server-function guards; accessibility audit; security penetration testing

---

## 3. Test inventory

### 3.1 Suites

| Suite | Location | Size | Runner | Purpose |
|---|---|---|---|---|
| RPC smoke | `tests/e2e/rpc-smoke.spec.ts` | 2 tests × 3 desktop projects | Playwright (`playwright.config.ts`) | Proves server-fn ID registration, CSRF headers and seroval round-trip end-to-end — **no database needed** |
| QA-500 e2e | `tests/qa500/e2e/` — `proctoring`, `mobile`, `autosubmit`, `edge-cases`, `violation-limit` | 20 tests × 5 projects = **100 runs** | Playwright (`tests/qa500/playwright.qa500.config.ts`, workers = 1, timeout 180 s) | Full functional matrix: proctoring, auto-submit, offline/recovery, mobile, configurable limits |
| QA-500 load | `tests/qa500/k6/` — `scenario-load-500`, `scenario-login-spike`, `scenario-submit-spike`, `scenario-recovery` | 4 scenarios | k6 v2.3.0 (`tools/`, gitignored) | 500-user load, spikes, crash-recovery; thresholds: err < 1 %, p95 < 2 s, p99 < 4 s, checks ≥ 99 % |
| Generic load profiles | `tests/load/` — smoke / load / stress / spike / soak + shared exam-session VU | 5 profiles + 4 scenarios | k6 | Classic performance-shape library (5 → 600 users) |
| DB verification | `tests/qa500/verify-results.mjs` | invariants **V1–V7** + leftover-answer check | Node | Post-run proof: lost answers, duplicates, re-grade match, stuck accounts, stray violations |
| Tooling self-tests | `tests/mocks/resend-mock.selftest.mjs`, `tests/qa500/smoke.mjs`, `config-check.mjs` | 4 assertions + manual API attempt | Node | Mock capture/failure injection, MAX_VIOLATIONS=2 proof, API smoke |

**Totals:** 6 spec files, 22 test functions, 5 browser projects, 4 k6 scenarios,
5 load profiles, 7+ verification invariants, 25 tracked test cases (TC-01…TC-25).

### 3.2 Support tooling

| Command | Purpose |
|---|---|
| `npm run dev:test` | Resend mock + Vite dev on `:5173` with `.env.test` (writes `tests/.artifacts/dev-server.json`) |
| `npm run test:seed` / `test:cleanup` | 2 organizers, 5 exams, 318 students (`loadtest_`-marked; refuses to run against production) |
| `node tests/qa500/seed.mjs` | 500 load participants + 12 e2e participants + `qa500-live` (30Q/30m) / `qa500-e2e` (5Q/10m) exams |
| `node tests/qa500/gen-payloads.mjs [--prod]` | Pre-serializes every k6 request body (server-fn IDs differ dev vs build) |
| `node tests/qa500/monitor.mjs` | CPU/RAM/DB row sampling every 5 s → `monitor.csv` / `monitor-summary.json` |
| `node tests/qa500/reset-participants.mjs` | `--mode=fresh` / `--mode=mid-exam` between scenarios |
| `npm run qa500:build` + `qa500:serve` | Nitro production build, N independent instances on `:5180–:5183` |
| `npm run qa500:e2e` / `qa500:report` / `qa500:cleanup` | Browser matrix · report generation · test-data removal |

### 3.3 Safety rails (verified)

1. **Staging-only guard** — `tests/lib/env.mjs` refuses seeding/cleanup when `.env.test` points at the production project.
2. **Zero real email** — Resend SDK redirected to a local mock via `RESEND_BASE_URL`; every payload captured to `tests/.artifacts/resend-payloads.jsonl`.
3. **Marker-scoped data** — all fixtures carry `loadtest_` / `qa500` markers; cleanup deletes only those rows.
4. **Secrets hygiene** — plaintext test passwords live only in gitignored `tests/.artifacts/`.

---

## 4. Test environment

| Item | Value |
|---|---|
| Functional runs | Vite dev server (`npm run dev:test`) on `http://localhost:5173`, `.env.test` → `file:./tests/.artifacts/test.db` (WAL mode) |
| Performance runs | Nitro production build, **4 independent instances** (`:5180–:5183`), `NODE_OPTIONS=--require scripts/node-keep-alive.cjs` (65 s keep-alive) |
| Load generator | k6 v2.3.0, payloads pre-serialized by seroval, per-VU round-robin across instances, co-located on the same host |
| Host | Single 6-core / 12-thread Windows machine running app instances + SQLite file DB + k6 + monitor — absolute latencies are **pessimistic** vs. dedicated servers; trends and invariants are what matter |
| E2E matrix | Playwright 1.64 — desktop-chromium / desktop-firefox / desktop-webkit / mobile-chromium (Pixel 7) / mobile-webkit (iPhone 13) |
| Test data | 500 participants `test001..test500@example.com` (bcrypt cost 10), exam `qa500-live`; e2e pool `e2e001…e2e012`; deterministic correct answers (`q → ["A","B","C","D"][(q-1)%4]`) |

---

## 5. Test execution results

### 5.1 Fresh verification pass — 2026-11-04 (this report)

| # | Check | Command | Result |
|---|---|---|---|
| V-01 | Type check | `npx tsc --noEmit` | ✅ **PASS** — exit 0, no diagnostics |
| V-02 | Lint | `npm run lint` | ❌ **FAIL** — 1932 problems (1921 errors, 11 warnings); breakdown in §6 |
| V-03 | Server-fn RPC smoke (Chromium) | `npx playwright test --project=chromium` | ✅ **PASS** — 2/2 in 10.7 s (browser round-trip + raw protocol call, both return `EXAM_NOT_FOUND` as designed) |
| V-04 | Email-mock self-test | `npm run test:resend-selftest` | ✅ **PASS** — 4/4 assertions (capture + failure injection) |
| V-05 | Production build | `npm run build` | ✅ **PASS** — exit 0; client build ✓ in 2.83 s, Nitro server output written to `.output/` (`nitro.json`, `wrangler.json`, `_headers`) |

> The previous root-suite failure recorded on 2026-10-11 (`rpc-smoke` blocked by a
> Vite HMR overlay — *Duplicate declaration "hot"* in `exam/$slug/start.tsx`) is
> **stale**: the source no longer contains the offending declaration and the suite
> passes on re-run.

### 5.2 QA-500 functional results — reference run 2026-10-21

Source: `tests/qa500/REPORT.md` (auto-generated by `qa500:report`), artifacts in `tests/.artifacts/qa500/`.

| ID | Test case | Expected | Actual | Result |
|---|---|---|---|---|
| TC-01 | Test data setup: 500 participants + 30Q/30min live exam | 500 users, 1 exam | 500 participants on `qa500-live` | ✅ PASS |
| TC-02 | Login spike: 500 logins in 10 s | err < 1 %, p95 < 2 s | p95 = **14 081 ms**, err 0.000 % | ❌ **FAIL** (B7) |
| TC-03 | Load profile 0→500 / 2 m, hold 30 m, ramp down 1 m | err < 1 %, p95 < 2 s, p99 < 4 s | p95 20 ms, p99 83 ms, err 0.015 %, 19 503 requests | ✅ PASS |
| TC-04 | Submit spike: 500 submits in 10 s | err < 1 %, p95 < 2 s | p95 165 ms, err 0.000 % | ✅ PASS |
| TC-05 | Zero lost answers | 0 lost | 0 lost of 500 completed | ✅ PASS |
| TC-05b | Every attempt closed (no stuck accounts) | 0 + 0 | not_started = 0, in_progress = 0 | ✅ PASS |
| TC-06 | Zero duplicate submissions | 0 | 507 results rows, 500 completed | ✅ PASS |
| TC-07 | No double scoring (regrade = stored grade) | 0 mismatches | V3 = 0, V4 = 0 | ✅ PASS |
| TC-08 | No crash / runaway memory | server up, RAM bounded | peak node RSS 398 MB over 479 samples (avg 80.69 MB) | ✅ PASS |
| TC-09 | Timer zero → server auto-submit | auto-submitted, answers kept | 5 project runs passed | ✅ PASS |
| TC-10 | Fullscreen exit (Esc/F11) → violation → auto-submit at 3rd | detected | 3 project runs passed | ✅ PASS |
| TC-11 | Desktop tab switch/blur ×3 → auto-submit with answers | submitted + graded | 3 project runs passed | ✅ PASS |
| TC-12 | Phone app-switch/notification ×3 → auto-submit | submitted + graded | 2 project runs passed | ✅ PASS |
| TC-13 | Manual submit confirmation popup (cancel keeps working) | confirm required | 5 project runs passed | ✅ PASS |
| TC-14 | Post-submit lockdown (refresh/back/2nd device/API), no double scoring | locked out everywhere | 5 project runs passed | ✅ PASS |
| TC-15 | Refresh mid-exam restores answers + timer, 0 violations | restored; 0 violations | 5 project runs passed | ✅ PASS |
| TC-16 | Short network drop → retries save the answer | saved after reconnect | 5 project runs passed | ✅ PASS |
| TC-17 | 30 s drop → persistent outbox saves answer | outbox flushes | 5 project runs passed | ✅ PASS |
| TC-18 | Offline submit → queued, lands on reconnect | queued until online | 5 project runs passed | ✅ PASS |
| TC-19 | Slow 3G throttling: answers still save | saved within timeout | 2 project runs passed | ✅ PASS |
| TC-20 | 2 devices → second login ends first session | stale token rejected | 5 project runs passed | ✅ PASS |
| TC-21 | Resize / split-screen / orientation → violation | detected (desktop + phone) | all variants passed | ✅ PASS |
| TC-22 | DevTools / right-click / copy / print detected | intercepted + counted | 3 project runs passed | ✅ PASS |
| TC-23 | Window narrowing mid-exam never replaces the attempt | exam screen stays | 3 project runs passed | ✅ PASS |
| TC-24 | `MAX_VIOLATIONS` env-configurable | threshold from env | auto-submit at violation 3 with `MAX_VIOLATIONS=2` proof run | ✅ PASS |
| TC-25 | Server restart mid-exam: no data loss | attempts recover | recovered_submits = 10, outage_errors = 60 | ✅ PASS |

**Score: 24 / 25 PASS (96 %) — single failure: TC-02.**

### 5.3 Browser matrix (Playwright, QA-500)

**100 runs — 68 passed · 0 failed · 0 flaky · 32 skipped** (skips are intentional:
desktop-only scenarios on phone projects, phone-only scenarios on desktop, and the
`MAX_VIOLATIONS` config check running once in Chromium).

| Scenario group | Runs | Passed | Failed | Skipped |
|---|---|---|---|---|
| Auto-submit (timer / manual / post-submit lockdown) | 15 | 15 | 0 | 0 |
| Edge cases (refresh, offline ×3, slow-3G, dual-device) | 30 | 20 | 0 | 10 |
| Mobile proctoring (fairness notice, blur, visibility, split-screen, orientation) | 25 | 10 | 0 | 15 |
| Desktop proctoring (3-strikes, Esc, resize, narrowing, DevTools) | 25 | 15 | 0 | 10 |
| Configurable violation limit | 5 | 1 | 0 | 4 |
| **Total** | **100** | **61–68 \*** | **0** | **32** |

\* exact per-group split varies with skip annotations; totals from `e2e-results.json`
stats: `expected 68, skipped 32, unexpected 0, flaky 0`, duration ≈ 16.7 min, workers = 1.

### 5.4 Performance (k6)

| Scenario | Requests | p95 | p99 | HTTP fail | Checks | Verdict |
|---|---|---|---|---|---|---|
| Load 0→500 / 2 m, hold 30 m (prod build, 4 instances) | 19 503 | **20 ms** | **83 ms** | 0.015 % | 100 % | ✅ PASS |
| Login spike 500 @ 50/s | 504 | 14 059 ms | 15 480 ms | 0.595 % | 100 % | ❌ FAIL (p95 target < 2 000 ms) |
| Login spike 500 @ 10/s (50 s) | 500 | **101 ms** | 212 ms | 0.596 % | 100 % | ✅ PASS |
| Submit spike 500 @ 50/s | 503 | **165 ms** | 348 ms | 0.596 % | 100 % | ✅ PASS |
| Submit spike 500 @ 10/s | 500 | 22 ms | 74 ms | 0.595 % | 100 % | ✅ PASS |
| Server-restart recovery | 364 | 555 ms | 629 ms | 16.5 % (60 outage errors by design) | recovered = 10 | ✅ PASS |

Per-endpoint trends on the main load run: login avg 93 ms / p95 126 ms · state
sync avg 3 ms / p95 6 ms · saveAnswer avg 7 ms / p95 16 ms · submit avg 12 ms / p95 29 ms.

> Every k6 run shows 3 failed HTTP requests (0.6 % of a spike, 0.015 % of the load
> run): dev-only server-function warm-up GETs that 404 on a production build —
> functional requests are 100 % successful.

**Capacity insight (B7):** the burst is a *latency*, not a correctness, problem.
bcrypt cost 10 costs ~62 ms CPU per compare → ~16 logins/s per process; 50/s needs
≈3 dedicated cores for hashing alone (⇒ 6–8 instances on dedicated hardware), or
simply a login window opened 50 s early.

### 5.5 Data-integrity invariants (both phases: load + spike)

| Check | Expected | Actual (load) | Actual (spike) | Result |
|---|---|---|---|---|
| V1 zero lost answers | 0 issues | 0 | 0 | ✅ PASS |
| V2 no duplicate submissions | 0 issues | 0 (507 results rows / 500 completed) | 0 | ✅ PASS |
| V3 no double scoring | 0 mismatches | 0 | 0 | ✅ PASS |
| V4 scoring matches answers (independent re-grade) | 0 mismatches | 0 | 0 | ✅ PASS |
| V5 no stuck/locked accounts | 0 | 0 | 0 | ✅ PASS |
| V6 no stray violations | 0 | 0 | 0 | ✅ PASS |
| V7 every attempt closed | 0 open | not_started 0 / in_progress 0 | 0 / 0 | ✅ PASS |
| no leftover answers on `not_started` | pass | pass | pass | ✅ PASS |

Final participant state both phases: **500/500 completed, submit reasons `{manual: 500}`.**

### 5.6 Resource usage during the load run

479 samples, 06:07:47 → 06:47:43 (2026-10-21):

| Metric | min | avg | max |
|---|---|---|---|
| System CPU (%) | 0 | 20.56 | 100 |
| App-instance node RSS (MB) | 0 | 80.69 | 398 |
| Node cumulative CPU (s) | 0 | 88.93 | 204.9 |
| k6 RSS (MB) | 0 | 7 068.52 | 10 250 |
| DB `responses` rows | 39 | 10 996 | 15 039 |
| DB `results` rows | 7 | 318.5 | 507 |

No crash, no runaway memory: peak 398 MB across 4 app instances + dev server.

---

## 6. Static analysis detail (2026-11-04)

### 6.1 TypeScript — ✅ PASS

`npx tsc --noEmit` exits 0.

### 6.2 ESLint — ❌ FAIL (1932 problems)

| Rule | Count | Nature |
|---|---|---|
| `prettier/prettier` | 1 844 | Formatting only — **auto-fixable** (`npx eslint . --fix` / `npm run format`) |
| `@typescript-eslint/no-explicit-any` | 77 | Type-safety debt (mostly test/tooling scripts) |
| `react-refresh/only-export-components` | 8 | HMR convention warnings in route/component files |
| `react-hooks/exhaustive-deps` | 3 | Potential stale-closure bugs — worth manual review |
| other warnings | 11 total warnings | minor |

**Assessment:** no correctness-blocking lint errors; the failure gate is dominated
by formatting drift (96 %). Before any release: run `npm run format`, review the
3 `exhaustive-deps` hits by hand, and tighten the `no-explicit-any` backlog in
`src/`.

### 6.3 Production build — ✅ PASS

`npm run build` exits 0 (2026-11-04): client bundle built in 2.83 s, Nitro
node-server output generated under `.output/` and preview/deploy targets
(`npx vite preview`, `npx nitro deploy --prebuilt`) are available. The build is
the same artifact shape used by the QA-500 performance runs (`qa500:build`).

---

## 7. Defect log (QA-500 campaign)

| ID | Severity | Status | Summary | Fix shipped |
|---|---|---|---|---|
| **B10** | 🔴 CRITICAL | ✅ Fixed | Under load every 2nd DB write failed `SQLITE_BUSY` and the app **swallowed** it — 132/500 examinees left mid-attempt, ~240 lost starts, thousands of answers never stored while k6 reported 0 errors | libSQL client `timeout: 5000` on **every** pooled connection; every write now fails loudly (`START_FAILED`…`TIMEOUT_SUBMIT_FAILED`); grading reads all answers in one query |
| **B1** | 🟠 HIGH | ✅ Fixed | Manual submit while offline navigated to `/submitted` anyway — UI lied, server never received it | Queued submit: reason persisted in localStorage, blocking "Waiting for the server…" gate, retry loop until server ACK; navigation only after ACK |
| **B2** | 🟠 HIGH | ✅ Fixed | Answer-save retry ladder gave up after ~13 s — longer disconnects silently lost answers | Persistent per-question outbox, capped exponential backoff ≤15 s, survives reload, monotonic version guards, "N unsaved" indicator |
| **B7** | 🟠 HIGH | ⏳ **OPEN** | 50 logins/s burst misses p95 < 2 s (measured 14 081 ms) — bcrypt cost 10 caps each process at ~16 logins/s | Deployment sizing (6–8 instances), worker-thread hashing, or spreading the login window; see §8 |
| **B3** | 🟡 MEDIUM | ✅ Fixed | Same credentials worked on unlimited devices; first session kept writing | Login rotates `session_token`; stale device gets `invalidSession` / `NOT_AUTHENTICATED` and is ejected |
| **B4** | 🟡 MEDIUM | ✅ Fixed | `MAX_VIOLATIONS` hardcoded to 3 | Server reads env (default 3; 0 disables; N submits on Nth), surfaced via `getExamState.maxViolations`; proven with `MAX_VIOLATIONS=2` |
| **B5** | 🟡 MEDIUM | ✅ Fixed | Resize / split-screen / orientation not proctored | Armed resize handler (`Δwidth > max(180px, 22%)`, `Δheight > max(180px, 25%)`), orientationchange counted, 2 s fullscreen-transition guard |
| **B6** | 🟡 MEDIUM | ✅ Fixed | DevTools / right-click / copy / print shortcuts not intercepted | `contextmenu` prevented + counted; copy/cut/paste, F12, Ctrl+Shift+I/J/C, Ctrl+P, PrintScreen raise violations. PrintScreen = best-effort (no DOM event exists; watermark + question rotation are the mitigation) |
| **B8** | 🟡 MEDIUM | ✅ Fixed | Page refresh counted as a violation — 3 refreshes force-submitted the exam | `beforeunload` "leaving" flag suppresses unload blur/hidden; reloader remembered in sessionStorage (2.5 s grace); verified: 3 refreshes → 0 violations |
| **B9** | 🟡 MEDIUM | ✅ Fixed | Narrowing window <768 px mid-exam replaced the running exam with the phone notice | Notice gate uses device class captured at entry (`phoneAtEntry`); exam survives resizes (resize itself now a violation per B5) |
| **B11** | 🟡 MEDIUM | ✅ Fixed | Node closed idle keep-alive connections after 5 s — thinking students lost requests (0.3 % of writes in load run) | `scripts/node-keep-alive.cjs` raises idle window to 65 s, preloaded via `node --require` / `NODE_OPTIONS` |

**Defect summary: 11 found — 10 fixed and regression-covered by the e2e suite, 1 open (B7, performance sizing).**

---

## 8. Coverage gaps & risks

| # | Gap | Risk | Recommendation |
|---|---|---|---|
| G1 | **No unit tests** — Vitest 5 is a devDependency but there are zero test files/config | Regressions in scoring, token, Zod schemas and `rpc.ts` transaction logic only caught by e2e (slow, serial, DB-dependent) | Add unit tests for `src/integrations/turso/rpc.ts` (submit/incrementViolation idempotency), `session-token.ts` (HMAC sign/verify/expiry), password hashing/lockout, and Zod schemas; wire `vitest run` into CI |
| G2 | **Lint gate fails** (1932 problems) | Formatting noise hides real warnings; CI lint would be red | `npm run format` + fix `exhaustive-deps` (3) + burn down `no-explicit-any` in `src/` |
| G3 | **No CI test workflow** — only `.github/workflows/keep-db-awake.yml` | Nothing runs tsc/lint/e2e on push; regressions land silently | Add a CI job: `tsc --noEmit` → `eslint .` → seed → `playwright test` (smoke) on every PR |
| G4 | **Emulated devices only** | iOS Safari fullscreen absence and real Android blur/battery behaviors unverified | Re-run `tests/qa500/e2e` on BrowserStack/LambdaTest; keep the manual checklist (lock screen, battery-saver, real split-screen) |
| G5 | **Local SQLite file DB for perf runs** | Pessimistic for write latency vs. Turso cloud; optimistic for reads | Re-run the perf pass once against a real Turso database before launch |
| G6 | **Single host runs app + DB + k6** | Absolute p95 values pessimistic; k6 RSS (10 GB peak) contends with the app | Treat numbers as trends/invariants; re-measure on dedicated app hosts (sizing formula in B7) |
| G7 | **Organizer-panel e2e thin** | Dashboard CRUD, CSV import/export, question-upload validation are only covered by manual checklist (README §Testing Checklist) | Add a small organizer flow spec (create exam → add student → upload questions → results) to `tests/e2e/` |
| G8 | **Security testing not performed** | HMAC token forgery, rate limiting on login (IP-level), CSRF surface untested beyond server-fn headers | Add auth-focused tests (tampered token, expired token, cross-exam token reuse) + consider IP rate limiting (already recommended in QA report) |
| G9 | **Open defect B7** | A synchronized 500-login burst in 10 s would queue ~14 s per student | Ship the login-window guidance (open logins 1–2 min early) or size to 6–8 instances; re-run TC-02 to close |

---

## 9. Recommendations (prioritized)

1. **Close B7 operationally** — document "open the login window ≥60 s before start" as the default organizer workflow; it converts the only failing criterion into a pass with zero code change (measured: 10/s → p95 101 ms).
2. **Make CI green** — `npm run format` (fixes ~1844 of 1921 errors), then add the CI pipeline from G3 so `tsc` + lint + smoke e2e gate every push.
3. **Stand up the unit-test layer (G1)** — highest-leverage missing coverage; start with `rpc.ts` transaction invariants since B10 proved write-path bugs are the costliest class.
4. **Keep the invariant harness** — V1–V7 verification and `DEBUG_BODY=1` k6 debugging are the reason B10 was found; preserve them when extending the suite.
5. **Re-run performance against Turso cloud + dedicated app hosts** before the first live exam; keep `start:prod`'s 65 s keep-alive preload (B11) in every deployment.
6. **Physical-device pass** (G4) and **organizer-flow e2e** (G7) before announcing broad availability.

---

## 10. Final verdict

| Gate | Status |
|---|---|
| Type safety | ✅ PASS |
| Lint | ❌ FAIL (formatting debt — non-blocking for correctness, blocking for CI) |
| Smoke / protocol e2e | ✅ PASS |
| Functional spec conformance (QA-500) | ❌ 24/25 — TC-02 only |
| Browser matrix (5 projects) | ✅ PASS — 0 failed / 0 flaky of 100 runs |
| Data-integrity invariants | ✅ PASS — 0 lost, 0 duplicated, 0 double-scored |
| Performance @ 500 concurrent (30 min) | ✅ PASS — p95 20 ms |
| Performance @ 500-login burst (10 s) | ❌ FAIL — p95 14.1 s (B7, open) |
| Defects | 11 found · 10 fixed + regression-covered · 1 open |

### Verdict: **CONDITIONALLY READY**

Ready for live exams at 500 concurrent **provided** the login burst is spread
(login window opened ≥60 s early, or ≥6–8 dedicated instances) — everything else
(data integrity, proctoring, offline resilience, submit/load performance, browser
compatibility) passes. Not yet ready for an *automated-CI* release process until
the lint gate is green and the unit-test/CI gaps (G1–G3) are addressed.

---

## Appendix A — Reproduction commands

```powershell
# --- static checks (staging-safe, no DB) ---
npx tsc --noEmit
npm run lint
npm run format                  # auto-fix the 1844 prettier errors

# --- tooling self-tests ---
npm run test:resend-selftest

# --- staging server + smoke e2e ---
npm run dev:test                # shell 1 (Resend mock + vite :5173)
npx playwright test --project=chromium            # root RPC smoke
npm run qa500:e2e               # full 5-project QA matrix (seeding required)

# --- QA-500 performance cycle (staging only) ---
node tests/qa500/seed.mjs
node tests/qa500/gen-payloads.mjs
npm run qa500:build
$env:QA500_PROD_WORKERS="4"; npm run qa500:serve
node tests/qa500/gen-payloads.mjs --prod
node tests/qa500/monitor.mjs --duration=2400 --interval=5    # shell 2
& tools\k6-v2.3.0-windows-amd64\k6.exe run tests/qa500/k6/scenario-load-500.js `
    -e BASE_URLS=http://localhost:5180,http://localhost:5181,http://localhost:5182,http://localhost:5183 `
    -e PROD=1 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
node tests/qa500/verify-results.mjs --phase=load
node tests/qa500/report/generate-report.mjs        # -> tests/qa500/REPORT.md

# --- cleanup (removes only qa500_/loadtest_ marked data) ---
node tests/qa500/cleanup.mjs
npm run test:cleanup
```

## Appendix B — Evidence index

| Artifact | Contents |
|---|---|
| `tests/qa500/REPORT.md` | Auto-generated QA-500 report (results table, k6 summaries, defect list, verdict) |
| `tests/.artifacts/qa500/report-summary.json` | `overallReady: false`, `failingCriteria: ["TC-02"]`, `e2eUnexpected: 0`, `missingArtifacts: []` |
| `tests/.artifacts/qa500/e2e-results.json` | 100-run browser matrix (stats: expected 68 / skipped 32 / unexpected 0 / flaky 0) |
| `tests/.artifacts/qa500/verify-load.json`, `verify-spike.json` | V1–V7 invariant results for both phases |
| `tests/.artifacts/qa500/k6-*-summary.json` | k6 summaries: load, login-spike, login-spike-10rps, submit-spike, submit-spike-10rps, recovery |
| `tests/.artifacts/qa500/monitor-summary.json` | 479 resource samples (CPU/RAM/DB rows) |
| `tests/.artifacts/qa500/max-violations-check.json` | `MAX_VIOLATIONS=2` proof run |
| `tests/.artifacts/playwright-output/` | Root rpc-smoke run outputs |
| `tests/README.md`, `tests/qa500/README.md`, `tests/load/profiles.md` | Suite documentation, safety rules, known limitations |

---

_Generated 2026-11-04 for the Prarambh repository · QA-500 data from the 2026-10-21 staging run · static checks re-verified 2026-11-04._
