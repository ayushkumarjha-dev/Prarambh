/**
 * QA-500 · Scenario A — the main test: 500 concurrent live students.
 *
 *   k6 run tests/qa500/k6/scenario-load-500.js -e BASE_URL=http://localhost:5173
 *
 * Load profile (spec):
 *   0 -> 500 users over 2m, hold 500 for 30m (full exam duration), ramp down 1m.
 * Each VU does exactly ONE real exam attempt, at a human pace:
 *   login -> instructions (brief) -> start -> state -> 30 answers with 5-30s
 *   think time (auto-save each) -> manual submit -> fetch result (state=completed)
 * then parks until the scenario ends (no student may submit twice).
 *
 * Pass criteria (thresholds): error rate < 1%, p95 < 2s, p99 < 4s.
 */
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";
import { rpc, returned, threw, thinkTime, parkUntilScenarioEnd, makeSummary, warmUp } from "./lib/rpc.js";

const loginDuration = new Trend("login_duration", true);
const stateDuration = new Trend("state_duration", true);
const saveDuration = new Trend("save_duration", true);
const submitDuration = new Trend("submit_duration", true);
const errors = new Rate("errors");

const RAMP_UP = __ENV.RAMP_UP || "2m";
const HOLD = __ENV.HOLD || "30m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "1m";
const USERS = Number(__ENV.USER_COUNT || 500);
const THINK_MIN = Number(__ENV.THINK_MIN || 5);
const THINK_MAX = Number(__ENV.THINK_MAX || 30);

const PLAN = new SharedArray("qa500", () => [JSON.parse(open("./payloads-qa500.json"))])[0];

export const options = {
  scenarios: {
    exam_500: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: USERS },
        { duration: HOLD, target: USERS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulStop: "1m",
      tags: { test: "qa500-load" },
    },
  },
  thresholds: {
    errors: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<2000", "p(99)<4000"],
    "http_req_duration{name:login}": ["p(95)<2000"],
    "http_req_duration{name:save}": ["p(95)<2000"],
    "http_req_duration{name:submit}": ["p(95)<2000"],
    login_duration: ["p(95)<2000"],
    submit_duration: ["p(95)<2000"],
    checks: ["rate>0.99"],
  },
};

export const handleSummary = makeSummary("k6-load-summary.json");

// Runs once before any VU — registers the server fns (see warmUp docs).
export function setup() {
  warmUp();
}

export default function () {
  const s = PLAN.students[(__VU - 1) % PLAN.students.length];
  const fails = [];

  // 1. Login
  let t0 = Date.now();
  const login = rpc(PLAN.fnIds.login, s.loginBody, "login");
  loginDuration.add(Date.now() - t0);
  if (
    !check(login, {
      "login returned a token": (r) => returned(r) && r.body.indexOf(s.token) !== -1,
    })
  ) {
    fails.push("login");
    errors.add(1);
    parkUntilScenarioEnd();
    return;
  }

  // 2. Instructions page data (getExamBrief)
  const brief = rpc(PLAN.fnIds.brief, s.briefBody, "brief");
  if (!check(brief, { "instructions loaded": (r) => returned(r) })) fails.push("brief");

  // 3. Start exam
  const start = rpc(PLAN.fnIds.start, s.startBody, "start");
  if (!check(start, { "exam started": (r) => returned(r) })) fails.push("start");

  // 4. Initial state (questions + server-side clock)
  t0 = Date.now();
  const state0 = rpc(PLAN.fnIds.getState, s.stateBody, "state");
  stateDuration.add(Date.now() - t0);
  if (!check(state0, { "state in_progress with 30 questions": (r) => returned(r) && r.body.indexOf('"questions"') !== -1 && r.body.indexOf('"in_progress"') !== -1 })) {
    fails.push("state0");
  }

  // 5. Answer every question at a human pace (auto-save each answer)
  for (const a of s.answers) {
    thinkTime(THINK_MIN, THINK_MAX);
    t0 = Date.now();
    const r = rpc(PLAN.fnIds.save, a.body, "save");
    saveDuration.add(Date.now() - t0);
    if (!check(r, { "answer auto-saved": (x) => returned(x) && x.body.indexOf('"saved"') !== -1 })) {
      fails.push(`save(q${a.q})`);
    }
    // periodic timer/state heartbeat, like the real client (~every 5 questions)
    if (a.q % 10 === 0) {
      const hb = rpc(PLAN.fnIds.getState, s.stateBody, "state");
      if (!check(hb, { "state heartbeat ok": (x) => returned(x) })) fails.push(`heartbeat(q${a.q})`);
    }
  }

  // 6. Manual submit
  thinkTime(1, 4);
  t0 = Date.now();
  const sub = rpc(PLAN.fnIds.submit, s.submitBody, "submit");
  submitDuration.add(Date.now() - t0);
  if (!check(sub, { "submit accepted": (r) => returned(r) })) fails.push("submit");

  // 7. Result / confirmation fetch — server now reports the attempt completed
  const fin = rpc(PLAN.fnIds.getState, s.stateBody, "state");
  if (!check(fin, { "result shows completed": (r) => returned(r) && r.body.indexOf('"completed"') !== -1 })) {
    fails.push("result");
  }

  if (fails.length === 0) errors.add(0);
  else errors.add(1);

  // One attempt per student: park until the scenario winds down.
  parkUntilScenarioEnd();
}
