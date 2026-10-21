# QA-500 Test Report — Prarambh Online Examination

> Generated: 2026-10-21T07:34:06.325Z · staging only (never production)

## 1. Scope & environment

| Item | Value |
|---|---|
| Target | Prarambh exam portal (TanStack Start SSR + libSQL/SQLite → Turso) |
| Base URL | functional: `npm run dev:test` (Vite, http://localhost:5173) · performance: Nitro production build, 4 independent instances on :5180–:5183 (`npm run qa500:build` + `qa500:serve`) |
| Database | `file:./tests/.artifacts/test.db` from `.env.test` in WAL mode — isolated from production `.env` (guard: tests/lib/env.mjs) |
| Load tool | k6 v2.3.0 (bundled in `tools/`), payloads pre-serialized by seroval, per-VU round-robin across the instances |
| E2E tool | Playwright 1.64 — Chromium/Firefox/WebKit + Pixel 7/iPhone 13 emulation |
| Test data | 500 participants `test001..test500@example.com` (password `Qa500!Pass123`, bcrypt cost 10), exam `qa500-live` 30 MCQ/30 min, e2e exam `qa500-e2e` 5 MCQ/10 min |
| Caveat | App servers, local file DB and k6 share one 6-core/12-thread host — absolute latencies are pessimistic vs. dedicated servers; trends and invariants are what matter. |

### 1.1 Commands used (all staging-only)

```powershell
# one-time staging setup (.env.test -> file:./tests/.artifacts/test.db; guards block production)
node tests/qa500/seed.mjs                       # 500 participants + qa500-live / qa500-e2e exams
npm run dev:test                                # Vite on :5173 for the functional matrix

# functional matrix (Chromium/Firefox/WebKit + Pixel 7 / iPhone 13 emulation)
npx playwright test -c tests/qa500/playwright.qa500.config.ts

# performance: production build, 4 independent instances on :5180-:5183
npm run qa500:build
$env:QA500_PROD_WORKERS="4"; npm run qa500:serve
node tests/qa500/gen-payloads.mjs --prod        # server-fn ids differ in a build
node tests/qa500/monitor.mjs --duration=2400 --interval=5
$b = "http://localhost:5180,http://localhost:5181,http://localhost:5182,http://localhost:5183"
& $k6 run tests/qa500/k6/scenario-load-500.js    -e BASE_URLS=$b -e PROD=1 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
node tests/qa500/verify-results.mjs --phase=load
node tests/qa500/reset-participants.mjs --mode=fresh    # or --mode=mid-exam before the submit spike
& $k6 run tests/qa500/k6/scenario-login-spike.js  -e BASE_URLS=$b -e PROD=1 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
& $k6 run tests/qa500/k6/scenario-submit-spike.js -e BASE_URLS=$b -e PROD=1 --summary-trend-stats="avg,min,med,p(90),p(95),p(99),max"
node tests/qa500/verify-results.mjs --phase=spike
npm run qa500:config-check                      # MAX_VIOLATIONS=2 proof

# report
node tests/qa500/report/generate-report.mjs     # -> tests/qa500/REPORT.md
```

## 2. Results table (test case | expected | actual | pass/fail)

| ID | Test case | Expected | Actual | Result | Note |
|---|---|---|---|---|---|
| TC-01 | Test data setup: 500 participants + 30Q/30min live exam | 500 test users, 1 exam | 500 participants on qa500-live | PASS |  |
| TC-02 | Login spike: 500 logins in 10s | err <1%, p95 <2s | p95=14081 ms, err=0.000% | FAIL | p95=14059 ms (target <2000ms); p99=15480 ms (target <4000ms); login p95=14081 ms (target <2000ms) |
| TC-03 | Load profile: 0→500 in 2m, hold 30m, ramp down 1m | err <1%, p95 <2s, p99 <4s | p95=20 ms, p99=83 ms, err=0.015%, requests=19503 | PASS |  |
| TC-04 | Submit spike: 500 submits in 10s | err <1%, p95 <2s | p95=165 ms, err=0.000% | PASS |  |
| TC-05 | Zero lost answers (every planned answer is stored with the same option) | 0 lost | 0 lost of 500 completed | PASS |  |
| TC-05b | Every seeded examinee closed their attempt (none stuck in not_started / in_progress) | 0 + 0 | not_started=0, in_progress=0 | PASS | B10 fixed |
| TC-06 | Zero duplicate submissions | 0 duplicates | results=507, completed=500 | PASS |  |
| TC-07 | No double scoring (regrade matches stored grade) | 0 mismatches | V3=0, V4=0 | PASS |  |
| TC-08 | No server crash / runaway memory during the run | server up, RAM bounded | peak node RSS 398MB over 479 samples (avg 80.69MB) | PASS |  |
| TC-09 | Timer zero → auto-submit (server is source of truth) | auto-submitted, answers kept | 5 project runs passed | PASS |  |
| TC-10 | Exiting full screen (Esc/F11) → violation → auto-submit | detected + auto-submit at 3rd | 3 project runs passed | PASS |  |
| TC-11 | Desktop: tab switch/blur/hidden ×3 → auto-submit with answers | submitted + answers graded | 3 project runs passed | PASS |  |
| TC-12 | Phone: app switch/notifications ×3 → auto-submit | submitted + answers graded | 2 project runs passed | PASS |  |
| TC-13 | Manual submit shows confirmation popup (cancel = keep working) | confirm required | 5 project runs passed | PASS |  |
| TC-14 | After submit: refresh/back/2nd device/API all refused, no double scoring | locked out everywhere | 5 project runs passed | PASS |  |
| TC-15 | Refresh mid-exam: answers + timer restore, attempt stays open, no penalty | restored; 0 violations (B8) | 5 project runs passed | PASS | B8 fixed |
| TC-16 | Short network drop → retries save the answer | answer saved after reconnect | 5 project runs passed | PASS |  |
| TC-17 | 30s drop → answer queued and saved automatically after reconnect | persistent outbox flushes | 5 project runs passed | PASS | B2 fixed |
| TC-18 | Offline submit → queued, no false success, lands on reconnect | submit queued until online | 5 project runs passed | PASS | B1 fixed |
| TC-19 | Slow 3G throttling: answers still save | saved within timeout | 2 project runs passed | PASS |  |
| TC-20 | Same user on 2 devices → second login ends the first session | stale token rejected | 5 project runs passed | PASS | B3 fixed |
| TC-21 | Resize / split-screen / orientation change registers a violation | detected on desktop + phone | desktop: PASS; phone split-screen: PASS; phone orientation: PASS | PASS | B5 fixed |
| TC-22 | DevTools / right-click / copy / print shortcuts detected | intercepted + counted | 3 project runs passed | PASS | B6 fixed |
| TC-23 | Narrowing the window mid-exam never replaces a running attempt | exam screen stays | 3 project runs passed | PASS | B9 fixed |
| TC-24 | MAX_VIOLATIONS configurable (server env, surfaced to the client) | threshold from env, not hardcoded | MAX_VIOLATIONS=3: auto-submitted at violation 3 (pass) | PASS | B4 fixed |
| TC-25 | Server restart mid-exam: no data loss, attempt recoverable | all attempts submit after recovery | recovered_submits=10, outage_errors=60 | PASS |  |

## 3. Performance metrics

### 3.1 k6 summaries

| Scenario | Requests | p95 | p99 | HTTP fail rate | Iteration errors | Checks pass | Thresholds verdict |
|---|---|---|---|---|---|---|---|
| Load 0→500/2m hold 30m | 19503 | 20 ms | 83 ms | 0.015% | 0.000% | 100.000% | ✅ PASS |
| Login spike 500/10s | 504 | 14059 ms | 15480 ms | 0.595% | 0.000% | 100.000% | ❌ FAIL (p95=14059 ms (target <2000ms); p99=15480 ms (target <4000ms); login p95=14081 ms (target <2000ms)) |
| Submit spike 500/10s | 503 | 165 ms | 348 ms | 0.596% | 0.000% | 100.000% | ✅ PASS |
| Server-restart recovery | 364 | 555 ms | 629 ms | 16.484% | outage_errors=60 | recovered=10 | ✅ PASS |

**Burst vs. sustainable rate** (same code, same instances — only the arrival rate differs):

| Scenario | Rate | p95 | p99 | max | HTTP fail | Checks | Verdict |
|---|---|---|---|---|---|---|---|
| Login | 50/s (500 in 10 s) | 14081 ms | 15491 ms | 16908 ms | 0.595% | 100.000% | ❌ FAIL |
| Login | 10/s (500 in 50 s) | 101 ms | 212 ms | 312 ms | 0.596% | 100.000% | ✅ PASS |
| Submit | 50/s (500 in 10 s) | 165 ms | 351 ms | 446 ms | 0.596% | 100.000% | ✅ PASS |
| Submit | 10/s (500 in 50 s) | 22 ms | 74 ms | 238 ms | 0.595% | 100.000% | ✅ PASS |

Both spikes return every request successfully (0 iteration errors, 100% checks) at both rates — the burst is a *latency* problem, not a correctness problem: the queue grows because the arrival rate exceeds what the box can absorb (bcrypt for logins, one SQLite writer for the grading transactions).

_Note: every k6 run shows 3 failed HTTP requests (0.6% of a spike, 0.015% of the load run). They are the dev-only server-function warm-up GETs, which 404 on a production build; the functional requests are 100% successful._

Per-endpoint trends on the main load run (from `k6-load-summary.json`):

| Endpoint trend | avg | p95 | p99 | max |
|---|---|---|---|---|
| login | 93 ms | 126 ms | 308 ms | 1137 ms |
| state sync | 3 ms | 6 ms | 11 ms | 20 ms |
| saveAnswer | 7 ms | 16 ms | 35 ms | 758 ms |
| submit | 12 ms | 29 ms | 42 ms | 184 ms |

### 3.2 Resource usage during the run (CPU / RAM / DB)

| Metric | min | avg | max |
|---|---|---|---|
| System CPU (%) | 0% | 20.56% | 100% |
| Node (app instances) RSS (MB) | 0MB | 80.69MB | 398MB |
| Node cumulative CPU (s) | 0s | 88.93s | 204.89999999999998s |
| k6 RSS (MB) | 0MB | 7068.52MB | 10250MB |
| DB responses rows | 39 | 10995.99 | 15039 |
| DB results rows | 7 | 318.54 | 507 |

Samples: 479 (2026-10-21T06:07:47.480Z → 2026-10-21T06:47:43.793Z). SQLite file DB = single writer (the app instances share one file, WAL mode + 5s busy timeout). node.exe = the app instances under test (production build) plus any dev server running on the same box; k6.exe = the load generator on the same host (its RSS dominates).

### 3.3 Database invariants (zero lost answers / zero double scoring)

**Main load run** — phase `load`, participants: {"total":500,"not_started":0,"in_progress":0,"completed":500}, submit reasons: {"manual":500}

| Check | Expected | Actual | Result |
|---|---|---|---|
| V1_zero_lost_answers | no violations of the invariant | 0 issues | PASS |
| V2_no_duplicate_submissions | no violations of the invariant | 0 issues | PASS |
| V3_no_double_scoring | no violations of the invariant | 0 issues | PASS |
| V4_scoring_matches_answers | no violations of the invariant | 0 issues | PASS |
| V5_no_stuck_accounts | no violations of the invariant | 0 issues | PASS |
| V6_no_stray_violations | no violations of the invariant | 0 issues | PASS |
| not_started_with_leftover_answers | no violations of the invariant | 0 issues | PASS |
| V7_every_attempt_closed | no violations of the invariant | 0 issues | PASS |

**Submit spike** — phase `spike`, participants: {"total":500,"not_started":0,"in_progress":0,"completed":500}, submit reasons: {"manual":500}

| Check | Expected | Actual | Result |
|---|---|---|---|
| V1_zero_lost_answers | no violations of the invariant | 0 issues | PASS |
| V2_no_duplicate_submissions | no violations of the invariant | 0 issues | PASS |
| V3_no_double_scoring | no violations of the invariant | 0 issues | PASS |
| V4_scoring_matches_answers | no violations of the invariant | 0 issues | PASS |
| V5_no_stuck_accounts | no violations of the invariant | 0 issues | PASS |
| V6_no_stray_violations | no violations of the invariant | 0 issues | PASS |
| not_started_with_leftover_answers | no violations of the invariant | 0 issues | PASS |
| V7_every_attempt_closed | no violations of the invariant | 0 issues | PASS |

## 4. Browser test matrix (Playwright)

Totals: **100** test runs — 68 passed, 0 failed, 0 flaky, 32 skipped.

Projects: desktop-chromium, desktop-webkit, desktop-firefox, mobile-chromium (Pixel 7), mobile-webkit (iPhone 13).

### Scenario × status

| Scenario | Runs | Passed | Failed | Skipped |
|---|---|---|---|---|
| timer reaches zero -> server auto-submits, saved answers keep their marks | 5 | 5 | 0 | 0 |
| manual submit asks for confirmation; cancel keeps the exam open, confirm submits | 5 | 5 | 0 | 0 |
| after submission: refresh, back navigation, second device and raw API are all locked out; re-submit never double-scores | 5 | 5 | 0 | 0 |
| page refresh mid-exam restores answers and the server timer without a violation (B8 fixed) | 5 | 5 | 0 | 0 |
| short network drop (<13s): queued retries save the answer after reconnect | 5 | 5 | 0 | 0 |
| 30s network drop: the persistent outbox still saves the answer after reconnect (B2 fixed) | 5 | 5 | 0 | 0 |
| submit while offline: the submit is queued and lands automatically on reconnect (B1 fixed) | 5 | 5 | 0 | 0 |
| same user on two devices: the second login rotates the token and ends the first session (B3 fixed) | 5 | 5 | 0 | 0 |
| slow 3G throttling: answers still reach the server | 5 | 2 | 0 | 3 |
| phone fairness notice appears, then the exam starts WITHOUT a fullscreen lock | 5 | 2 | 0 | 3 |
| app switch / notification shade (blur) x3 auto-submits with answers saved | 5 | 2 | 0 | 3 |
| screen lock / app switch (visibilitychange hidden) is recorded as a violation | 5 | 2 | 0 | 3 |
| split-screen resize registers a violation on phones (B5 fixed) | 5 | 2 | 0 | 3 |
| orientation change registers a violation on phones (B5 fixed) | 5 | 2 | 0 | 3 |
| 3 violations auto-submit the exam with answers saved and redirect to the submitted page | 5 | 3 | 0 | 2 |
| exiting full screen (Esc / API exit) registers exactly one violation and can be recovered | 5 | 3 | 0 | 2 |
| window resize / half-screen snap registers a violation (B5 fixed) | 5 | 3 | 0 | 2 |
| narrowing the window mid-exam never replaces the exam with the phone notice (B9 fixed) | 5 | 3 | 0 | 2 |
| devtools / right-click / copy / print shortcuts are intercepted; the 3rd strike submits (B6 fixed) | 5 | 3 | 0 | 2 |
| auto-submits on exactly the configured limit (env-driven, not hardcoded) | 5 | 1 | 0 | 4 |

## 5. Defects found (severity, status, repro, fix)

### B1 — [HIGH] [FIXED] Manual submit while offline silently failed — the UI lied or hung, and the server never received it

- **Impact:** doSubmit() caught the network error and navigated to /submitted anyway. Offline the route chunk could not load, so the learner was stuck on a dead exam screen; back online the success page rendered even though the attempt was still in_progress. Only the server-side timer closed it (submit_reason='timeout', never 'manual').
- **Steps to reproduce:** e2e: edge-cases.spec.ts → 'submit while offline…' — start exam → context.setOffline(true) → Submit Test → confirm.
- **Fix shipped:** Submit is now queued: the reason is persisted in localStorage, a blocking 'Waiting for the server…' gate replaces the false success page, and a retry loop (5s interval + 'online' event) flushes until the server ACKs. Navigation to /submitted happens only after the ACK. A reload while offline resumes the queued submit.

### B2 — [HIGH] [FIXED] Answer-save retry ladder only covered ~13s — longer disconnects silently lost answers

- **Impact:** The banner promised 'Answers will keep retrying until you're back', but the 5-attempt ladder (0.6/1.4/3/6.2/12.6s) gave up after ~13s with only a transient toast.
- **Steps to reproduce:** e2e: edge-cases.spec.ts → '30s network drop…' — answer while offline for 30s → reconnect.
- **Fix shipped:** Persistent per-question outbox with capped exponential backoff (≤15s) that retries until the server ACK, flushes on the 'online' event, survives a reload (localStorage), guards against stale retries overwriting newer answers (monotonic version), and shows a 'N unsaved' indicator in the header.

### B3 — [MEDIUM] [FIXED] No concurrent-session control — same credentials worked on unlimited devices

- **Impact:** The session token was static and per-exam, so a second device could join and the first session kept writing answers.
- **Steps to reproduce:** e2e: edge-cases.spec.ts → 'same user on two devices…' — start on device 1, log in on device 2.
- **Fix shipped:** Every successful login rotates participants.session_token. The previous device gets {saved:false, invalidSession:true} on its next write and NOT_AUTHENTICATED on its next state sync; both paths end the session, show 'This exam is now open on another device' and return to login.

### B4 — [MEDIUM] [FIXED] MAX_VIOLATIONS was hardcoded to 3 — not configurable as required

- **Impact:** Strict exams could not auto-submit on the first violation; lenient mode could not raise the limit. The number lived in both the client UI and the server function.
- **Steps to reproduce:** Code inspection: start.tsx ('Violations: X / 3') + reportViolation (n >= 3).
- **Fix shipped:** Server reads MAX_VIOLATIONS (default 3; 0 disables auto-submit; N≥1 submits on the Nth violation) and returns it in getExamState.maxViolations; the UI renders every counter/overlay from that value. Proven by a dedicated check run with MAX_VIOLATIONS=2 (tests/.artifacts/qa500/max-violations-check.json).

### B5 — [MEDIUM] [FIXED] Resize / split-screen / orientation change alone was not proctored

- **Impact:** Only blur, visibilitychange, focus-poll and fullscreenchange were wired; a same-app split-screen or floating window without focus loss passed silently.
- **Steps to reproduce:** e2e: proctoring.spec.ts 'window resize / half-screen snap…' and mobile.spec.ts 'split-screen resize…'.
- **Fix shipped:** Armed resize handler records a violation when |Δwidth| > max(180px, 22%) or |Δheight| > max(180px, 25%); orientationchange is also a violation. Fullscreen transitions resize the viewport too, so they are excluded by a 2s guard plus a baseline refresh.

### B6 — [MEDIUM] [FIXED] DevTools / right-click / copy-paste / print shortcuts were not intercepted

- **Impact:** Spec asks for detection on these. No contextmenu/copy/keydown guards existed. PrintScreen has no reliable DOM event in any browser (platform limitation).
- **Steps to reproduce:** e2e: proctoring.spec.ts 'devtools / right-click / copy / print shortcuts…'.
- **Fix shipped:** contextmenu is prevented and counted; copy/cut/paste, F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+P and PrintScreen all raise a violation. The 3rd strike auto-submits. PrintScreen remains best-effort: the visible watermark + per-question rotation are the mitigation (documented limitation).

### B8 — [MEDIUM] [FIXED] Refreshing the page counted as a proctoring violation — three refreshes auto-submitted the exam

- **Impact:** Reloading is the documented recovery path after a crash/network blip, yet the reload fired blur/visibilitychange and incremented tab_violation_count (observed 1 per reload). At MAX_VIOLATIONS=3, three refreshes force-submitted a student.
- **Steps to reproduce:** e2e: edge-cases.spec.ts 'page refresh mid-exam…' — start → answer → reload ×3.
- **Fix shipped:** beforeunload/pagehide set a 'leaving' flag that suppresses the unload's blur/hidden events, the reloader is remembered in sessionStorage so the next mount ignores unload noise for 2.5s, and the focus poll ignores hidden documents. Normal exam starts stay strict from t=0. Verified: three consecutive refreshes → 0 violations, attempt intact.

### B9 — [MEDIUM] [FIXED] Narrowing the window below 768px mid-exam replaced the running exam with the phone notice

- **Impact:** detectPhone() treats any viewport <768px as a phone. A split-screen/snap (or a phone rotation) mid-exam flipped useIsPhone, which re-triggered the unacknowledged mobile notice and unmounted the exam UI — the attempt disappeared from the screen.
- **Steps to reproduce:** e2e/observation: enter an exam on desktop, resize the viewport to <768px → 'You're on a phone' notice replaces the exam.
- **Fix shipped:** The notice gate now uses the device class captured at entry (phoneAtEntry), so it can never eject a running attempt; the exam screen survives resizes (and the resize itself is now a violation, B5).

### B10 — [CRITICAL] [FIXED] Under load every second database write failed with SQLITE_BUSY — and the app swallowed the error, losing attempts and answers

- **Impact:** The local (file:) database is shared by 4 app instances and a pool of connections. SQLite's default busy timeout is 0, so the second concurrent writer failed instantly with "SQLITE_BUSY: database is locked". The app then ignored the failed write in five places: startExam (the attempt never left 'not_started' although the client was told 'ok'), loginExamParticipant (a token that was never stored), submitExam (the attempt stayed open although the client was told 'submitted'), reportViolation (a proctoring violation was lost) and the server-timer auto-submit. The k6 answer check only looked for the word "saved" in the response, so a REJECTED answer counted as saved. Measured effect in the 30-minute 500-user run: 132 of 500 examinees were left mid-attempt, ~240 attempts lost their start, and thousands of answers were never stored while the run reported 0 request errors.
- **Steps to reproduce:** k6 run tests/qa500/k6/scenario-load-500.js -e BASE_URLS=<4 instances> -e PROD=1 -e DEBUG_BODY=1 — the failing responses carry {"$TSR/Error": {message: "SQLITE_BUSY: database is locked"}} (HTTP 200, so no transport error is logged).
- **Fix shipped:** Three parts: (1) the libSQL client is created with `timeout: 5000`, which the driver applies to EVERY connection of the pool (a `PRAGMA busy_timeout` only reaches one connection — the original bug); (2) every write now checks the database result and fails loudly (START_FAILED / LOGIN_WRITE_FAILED / SUBMIT_FAILED / VIOLATION_WRITE_FAILED / TIMEOUT_SUBMIT_FAILED) so a lost write can never be reported as success; (3) grading reads all answers in ONE query instead of 30, which shortens the write transaction that holds SQLite's single writer lock.

### B11 — [MEDIUM] [FIXED] The Node server closed idle keep-alive connections after 5 s — a student who thought for 6 s lost the request

- **Impact:** Node's HTTP server closes an idle keep-alive socket after 5 seconds (server.keepAliveTimeout). An exam has 5-30 second think times, so the next request of a thinking student frequently landed on a socket the server had just closed: "wsarecv: An existing connection was forcibly closed by the remote host". Browsers retry such a request, API clients and the load generator do not — in the load run 0.3 % of the answer writes were lost this way, which by itself put 10 % of the examinees over the 1 % error limit.
- **Steps to reproduce:** k6 run tests/qa500/k6/scenario-load-500.js -e THINK_MIN=3 -e THINK_MAX=6 (think time above 5 s) — k6 logs 'Request Failed ... forcibly closed by the remote host' with status 0.
- **Fix shipped:** scripts/node-keep-alive.cjs raises the idle window to 65 s (the classic nginx keepalive_timeout) and is preloaded with `node --require`, because Nitro loads the app lazily — the server is already listening before any app module runs. The staging instances load it through NODE_OPTIONS (see tests/qa500/prod-server.mjs); a production Node deployment should do the same or front the app with a proxy that sets keepalive_timeout 65s. The browser client was never affected (it retries the request), but API clients and the k6 harness are.

### B7 — [HIGH] [OPEN] A 50 logins/s burst misses p95 < 2 s — bcrypt cost 10 caps each app process at ~16 logins/s

- **Impact:** Measured login p95 = 14081 ms (avg 10950 ms, target p95 < 2000 ms) with 0.000% iteration errors on 4 production instances (:5180–:5183, 12-vCPU host, k6 co-located). Root cause is password verification, not the framework: participants store bcrypt cost 10 hashes and one compare costs ~62 ms of pure CPU (measured on this host), i.e. a hard ceiling of ~16 logins/s per app process. A 50 logins/s arrival rate therefore needs ≥4 dedicated cores for hashing alone, plus request/DB work. Measured capacity curve: 10 logins/s → p95 101 ms, 0 % errors (PASS); 50 logins/s on 4 instances → p95 14081 ms, 0 % iteration errors, 100 % checks (FAIL on latency only — every login succeeded and returned the right token, the queue just grew).
- **Steps to reproduce:** k6 run tests/qa500/k6/scenario-login-spike.js -e BASE_URLS=http://localhost:5180,http://localhost:5181,http://localhost:5182,http://localhost:5183 -e PROD=1 (50/s) vs -e SPIKE_RATE=10.
- **Fix shipped:** Deployment sizing, not exam logic: bcrypt cost 10 is deliberately expensive, so 500 logins in 10 s needs roughly 6–8 app instances (or a separate auth service) where every core is available to the server — the staging box runs 4 instances, the SQLite writer and k6 on 6 cores. Cheaper alternatives, in order of preference: (a) open the login window before the exam start so the burst is spread (500 logins over 50 s already passes at 4 instances: p95 101 ms); (b) keep bcrypt cost 10 but hash on worker_threads so one instance can use all cores; (c) only then consider lowering the bcrypt cost (security trade-off). The same 4-instance staging deployment sustains the full 30-minute 500-user load (TC-03) and the 500-submit burst (TC-04) — only the 10-second login burst is over the box's capacity.

## 6. Recommendations

- **Horizontal scaling (B7)** — the app is stateless (HMAC tokens, DB-backed state), so scale out, not up: `qa500:serve` starts N independent instances and the load generator round-robins across them (Nitro ignores `node:cluster` — see README 6b). Password verification is the ceiling: bcrypt cost 10 costs ~62 ms of CPU per login, so size for `logins/s × 0.062` dedicated cores (≈3 cores for 50 logins/s) and keep the load generator off the app hosts.
- **Login window (cheapest fix for B7)** — open the exam's login 5–10 minutes before the start so 500 learners spread over minutes instead of 10 seconds. Measured: the same 4 instances serve 10 logins/s with p95 101 ms, while the 30-minute load run only needs ≈4 logins/s — an order of magnitude below capacity.
- **Database** — the staging DB is a local SQLite file with ONE writer; that is what bounds the submit burst (500 gradings serialize behind each other) and it is pessimistic vs. Turso, where the writes are concurrent on the server side. The app now opens file DBs in WAL mode with a 5 s busy timeout on every pooled connection and never reports a failed write as a success (B10). Keep production on Turso and watch the write latency: saveAnswer is an upsert per answer (≈15k writes per full exam of 500).
- **Keep-alive (B11 — shipped)** — `scripts/node-keep-alive.cjs` raises Node's 5 s idle keep-alive window to 65 s; the production build must be started with it (`npm run start:prod`), or a reverse proxy in front of it must set `keepalive_timeout 65s`.
- **Caching** — question documents are re-read on every getExamState/getExamBrief; cache the immutable question set doc (per exam) in-process with a short TTL or on exam start.
- **Rate limiting** — participant lockout exists (5 attempts/10 min). Add an IP-level limiter on login (e.g., 30/min) to blunt credential stuffing; keep the exam windows as the hard gate.
- **Offline resilience (B1/B2 — shipped)** — the client now keeps a persistent answer outbox and a queued submit that retries until the server ACKs, with a visible 'N unsaved' / 'Waiting for the server…' state. Re-verify on real 3G/4G handovers (the Playwright run uses CDP throttling and context-level offline).
- **Single-session enforcement (B3 — shipped)** — starting an exam rotates the participant's token and the stale device is ejected with an explanation; a plain login/refresh before the start no longer rotates it (so parallel logins during the ramp keep working). Consider also surfacing the active-device count to the organizer dashboard.
- **Proctoring completeness (B4/B5/B6/B8/B9 — shipped)** — MAX_VIOLATIONS is env-configurable, resize/orientation/contextmenu/copy/devtools shortcuts are counted, reloads never count, and narrowing the window can no longer eject a running attempt. Watermark + per-question rotation remain the PrintScreen mitigation (no DOM event exists).
- **Write-path safety (B10 — shipped)** — a database write that fails is now always reported as a failure (start / login / save / submit / violation / timer auto-submit) instead of being swallowed, and the staging client waits 5 s for the write lock instead of failing instantly. Keep this invariant when adding new server functions: a swallowed write looks like a lost answer.
- **Load-generator fidelity (shipped)** — the k6 scenarios now pick the student by iteration counter (not VU id: k6 assigns VUs in no fixed order, which silently skipped one student) and the DB verification compares every planned answer, not just the row count. Keep both when the suite is extended.
- **Real devices** — this run used emulation (Pixel 7 / iPhone 13 profiles). Re-run tests/qa500/e2e on BrowserStack/LambdaTest for physical Android/iOS; iPhone Safari has no Fullscreen API (the app's no-lock fallback is the documented behaviour).
- **Production-shaped performance pass (done)** — the perf suite was re-run against a Nitro production build served by 4 independent instances (`npm run qa500:build` + `qa500:serve`) on the same file DB; the remaining limit is bcrypt CPU, not SSR throughput. Re-run it once against Turso cloud (this staging DB is a local file, pessimistic for write latency).

## 7. Final verdict

- **Performance readiness (500 concurrent):** ❌ FAIL — p95=14059 ms (target <2000ms); p99=15480 ms (target <4000ms); login p95=14081 ms (target <2000ms)
- **Data-integrity invariants:** ✅ PASS
- **Functional spec conformance:** ❌ FAIL — 1 failing criteria: TC-02
- **E2E stability:** ✅ PASS

### ❌ VERDICT: Not ready for 500 live users

Reasons:
1. performance thresholds missed (see §3 — scale-out/login-burst guidance)
1. 1 functional criteria unmet (§2): TC-02 (p95=14059 ms (target <2000ms); p99=15480 ms (target <4000ms); login p95=14081 ms (target <2000ms))

Everything except the synthetic 10-second login burst passes: the 30-minute 500-user load, the 500-submit spike, all data-integrity invariants and every functional criterion. The single unmet criterion is **TC-02 (500 logins inside 10 s, p95 < 2 s)**: bcrypt cost 10 costs ~62 ms of CPU per login, so that profile needs ~6–8 dedicated instances, while this run used 4 instances sharing a 12-thread host with k6 and the SQLite writer. With the login window opened even 50 s before the exam (≈10 logins/s, measured p95 101 ms) the same 4 instances serve the full burst comfortably. See B7 for the measured curve and the sizing formula.

---
_Generated by tests/qa500/report/generate-report.mjs — all data from this machine's staging run._
