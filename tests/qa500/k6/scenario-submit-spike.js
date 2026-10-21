/**
 * QA-500 · Scenario C — submit spike: 500 students all clicking Submit within
 * 10 seconds (worst case at timer end). Participants must be pre-started with
 * 30 saved answers so every submit triggers FULL server-side grading:
 *
 *   node tests/qa500/reset-participants.mjs --mode=mid-exam
 *   k6 run tests/qa500/k6/scenario-submit-spike.js -e BASE_URL=http://localhost:5173
 *
 * Pass: error rate < 1%, p95 < 2s, and afterwards every one of the 500
 * attempts is graded exactly once (verified by tests/qa500/verify-results.mjs).
 */
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import { rpc, returned, thinkTime, parkUntilScenarioEnd, makeSummary, warmUp } from "./lib/rpc.js";

const submitDuration = new Trend("submit_duration", true);
const errors = new Rate("errors");

const RATE = Number(__ENV.SPIKE_RATE || 50); // per second
const DURATION = __ENV.SPIKE_DURATION || "10s"; // 50/s * 10s = 500 submits

const PLAN = new SharedArray("qa500", () => [JSON.parse(open("./payloads-qa500.json"))])[0];

export const options = {
  scenarios: {
    submit_spike: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 550,
      maxVUs: 650,
      gracefulStop: "30s",
      tags: { test: "qa500-submit-spike" },
    },
  },
  thresholds: {
    errors: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:submit}": ["p(95)<2000"],
    submit_duration: ["p(95)<2000", "p(99)<4000"],
  },
};

export const handleSummary = makeSummary("k6-submit-spike-summary.json");

// Runs once before any VU — registers the server fns (see warmUp docs).
export function setup() {
  warmUp();
}

export default function () {
  // Student index by ITERATION, not by VU (k6 assigns VUs to iterations in
  // no particular order -> one student can be skipped while another is hit
  // twice). See scenario-login-spike.js.
  const s = PLAN.students[exec.scenario.iterationInTest % PLAN.students.length];
  const t0 = Date.now();
  const sub = rpc(PLAN.fnIds.submit, s.submitBody, "submit");
  submitDuration.add(Date.now() - t0);
  const ok = check(sub, {
    "spike submit accepted": (r) => returned(r) && r.body.indexOf('"submitted"') !== -1,
  });
  errors.add(ok ? 0 : 1);
  thinkTime(1, 2);
  parkUntilScenarioEnd();
}
