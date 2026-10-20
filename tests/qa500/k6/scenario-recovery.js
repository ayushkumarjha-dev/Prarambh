/**
 * QA-500 · Scenario D — resilience: server restart mid-exam.
 *
 *   node tests/qa500/reset-participants.mjs --mode=mid-exam   # optional
 *   k6 run tests/qa500/k6/scenario-recovery.js -e BASE_URL=http://localhost:5173
 *
 * While this runs, restart the staging dev server inside the outage window
 * (default t=40s..80s; see README "server restart" procedure). 10 students
 * answer slowly the whole time.
 *
 * Expected outcome:
 *  - requests during the outage fail (counted separately as outage_errors,
 *    NOT as product errors)
 *  - after recovery: the exam state + previously saved answers are intact
 *    (everything lives in the DB), timer still server-authoritative
 *  - every attempt still submits successfully after recovery
 */
import { check } from "k6";
import { Rate, Counter } from "k6/metrics";
import { sleep } from "k6";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { rpc, returned, baseUrl, makeSummary, warmUp, warmUpVerified } from "./lib/rpc.js";

const errors = new Rate("errors");
const outageErrors = new Counter("outage_errors");
const recoveredSubmits = new Counter("recovered_submits");

const OUTAGE_START_S = Number(__ENV.OUTAGE_START_S || 40);
const OUTAGE_END_S = Number(__ENV.OUTAGE_END_S || 80);

const PLAN = new SharedArray("qa500", () => [JSON.parse(open("./payloads-qa500.json"))])[0];

export const options = {
  scenarios: {
    recovery: {
      // exactly one attempt per VU: login -> 30 answers (spanning the outage)
      // -> state -> submit. Avoids iteration-2 noise (login-after-submit is
      // correctly refused by the product and would pollute the metrics).
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 1,
      maxDuration: "3m",
      gracefulStop: "20s",
      tags: { test: "qa500-recovery" },
    },
  },
  thresholds: {
    // outage failures are expected; only post-recovery submits must pass
    recovered_submits: ["count>=10"],
  },
};

export const handleSummary = makeSummary("k6-recovery-summary.json");

// Runs once before any VU — registers the server fns (see warmUp docs) and
// PROVES they are callable before the VUs start (idle-server race).
export function setup() {
  warmUpVerified(PLAN.fnIds.login, PLAN.students[0].loginBody);
}

function inOutage() {
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  return t >= OUTAGE_START_S && t <= OUTAGE_END_S;
}

export default function () {
  const s = PLAN.students[(__VU - 1) % PLAN.students.length];
  let stepErrors = 0;
  let rewarmDone = false;

  // one quick login/state at the start (before the outage)
  const login = rpc(PLAN.fnIds.login, s.loginBody, "login");
  if (!check(login, { "pre-outage login ok": (r) => returned(r) })) stepErrors++;

  for (const a of s.answers) {
    sleep(3);
    // Emulate what a browser does after a dev-server restart: the fresh
    // server's in-memory lookup table is empty, and a page reload re-fetches
    // the provider modules (re-registering the server fns). Once the outage
    // window has passed, re-warm once before the next RPC.
    if (!rewarmDone && !inOutage() && (Date.now() - exec.scenario.startTime) / 1000 > OUTAGE_START_S) {
      try {
        warmUp();
        rewarmDone = true;
      } catch (_) {
        /* server still down — retry on the next answer */
      }
    }
    const r = rpc(PLAN.fnIds.save, a.body, "save");
    if (!returned(r)) {
      if (inOutage()) outageErrors.add(1);
      else stepErrors++;
    }
  }

  // After the outage: state must still resolve and the attempt must submit.
  const state = rpc(PLAN.fnIds.getState, s.stateBody, "state");
  const stateOk = check(state, {
    "post-recovery state resolves": (r) => returned(r) && r.body.indexOf('"status"') !== -1,
  });
  if (!stateOk && !inOutage()) stepErrors++;

  const sub = rpc(PLAN.fnIds.submit, s.submitBody, "submit");
  const subOk = check(sub, { "post-recovery submit succeeds": (r) => returned(r) });
  if (subOk) recoveredSubmits.add(1);
  else if (inOutage()) outageErrors.add(1);
  else stepErrors++;

  errors.add(stepErrors > 0 ? 1 : 0);
  void baseUrl;
}
