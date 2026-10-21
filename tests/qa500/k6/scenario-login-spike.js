/**
 * QA-500 · Scenario B — login spike: 500 students all logging in within 10s.
 *
 *   node tests/qa500/gen-payloads.mjs      # first (payloads)
 *   k6 run tests/qa500/k6/scenario-login-spike.js -e BASE_URL=http://localhost:5173
 *
 * Worst-case thundering herd at exam start. Each iteration = one unique
 * student (keyed by VU id) doing a single login, then parking — so no
 * student logs in twice.
 */
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import { rpc, returned, thinkTime, parkUntilScenarioEnd, makeSummary, warmUp } from "./lib/rpc.js";

const loginDuration = new Trend("login_duration", true);
const errors = new Rate("errors");

// Diagnostics: capture the first few failure shapes (status/error/body) so
// transport failures vs server errors are distinguishable in the run output.
let failuresLogged = 0;
function describeFailure(r) {
  if (failuresLogged >= 5) return;
  failuresLogged++;
  console.error(
    `[login-fail #${failuresLogged}] status=${r.status} error=${r.error || "-"} body=${(r.body || "").slice(0, 160)}`,
  );
}

const RATE = Number(__ENV.SPIKE_RATE || 50); // per second
const DURATION = __ENV.SPIKE_DURATION || "10s"; // 50/s * 10s = 500 logins

const PLAN = new SharedArray("qa500", () => [JSON.parse(open("./payloads-qa500.json"))])[0];

export const options = {
  scenarios: {
    login_spike: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 550,
      maxVUs: 650,
      gracefulStop: "30s",
      tags: { test: "qa500-login-spike" },
    },
  },
  thresholds: {
    errors: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:login}": ["p(95)<2000"],
    login_duration: ["p(95)<2000", "p(99)<4000"],
  },
};

export const handleSummary = makeSummary("k6-login-spike-summary.json");

// Runs once before any VU — registers the server fns (see warmUp docs).
export function setup() {
  warmUp();
}

export default function () {
  // Student index by ITERATION, not by VU: k6 assigns VUs to iterations in
  // no particular order, so `__VU - 1` can leave one student untested (and
  // submit the same student twice) when the iteration count exceeds the
  // student count. `iterationInTest` is a monotonic counter over all
  // iterations of the run, so every student is covered exactly once.
  const s = PLAN.students[exec.scenario.iterationInTest % PLAN.students.length];
  const t0 = Date.now();
  const login = rpc(PLAN.fnIds.login, s.loginBody, "login");
  loginDuration.add(Date.now() - t0);
  const ok = check(login, {
    "spike login returned a token": (r) => returned(r) && r.body.indexOf(s.token) !== -1,
  });
  if (!ok) describeFailure(login);
  errors.add(ok ? 0 : 1);
  thinkTime(1, 2); // tiny pause so the VU is not immediately reusable
  parkUntilScenarioEnd();
}
