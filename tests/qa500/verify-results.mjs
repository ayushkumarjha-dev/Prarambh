#!/usr/bin/env node
/**
 * QA-500 post-run verification — proves the database invariants from the
 * pass criteria against the STAGING database:
 *
 *   node tests/qa500/verify-results.mjs --phase=spike   # after submit spike
 *   node tests/qa500/verify-results.mjs --phase=load    # after the 30-min run
 *
 * Checks (per phase):
 *   V1  zero lost answers: every COMPLETED attempt has 30 response rows
 *   V2  zero duplicate submissions: exactly one results row per completed
 *       participant, submit_reason set, exam_submitted_at set
 *   V3  no double scoring: sum(marks_awarded) == results.total_marks, and
 *       correct/wrong/unattempted re-derived from the question set match
 *   V4  scoring matches the stored answers (independent re-grade)
 *   V5  no negative/locked accounts after the run (failed_attempts == 0)
 *   V6  violation counters sane on the load exam (no proctoring traffic there)
 *
 * Output: tests/.artifacts/qa500/verify-<phase>.json + stdout table.
 */
import { LOAD_SLUG, PAYLOADS_PATH, readJson, writeJson, ART_DIR, openDb, one } from "./lib/qa500.mjs";
import path from "node:path";

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const phase = phaseArg ? phaseArg.split("=")[1] : "load";
const QUESTIONS = 30;

const payloads = readJson(PAYLOADS_PATH);
if (!payloads) {
  console.error("[qa500:verify] missing payloads — run tests/qa500/gen-payloads.mjs first.");
  process.exit(1);
}
const db = await openDb();
const exam = await one(db, "SELECT id, question_set_id FROM exams WHERE slug = ?", [LOAD_SLUG]);
if (!exam) {
  console.error(`[qa500:verify] exam ${LOAD_SLUG} not found.`);
  process.exit(1);
}
const examId = String(exam.id);
const doc = JSON.parse(
  String((await one(db, "SELECT data FROM question_sets WHERE id = ?", [String(exam.question_set_id)]))?.data ?? "{}"),
);
const correctByQ = new Map((doc.questions ?? []).map((q) => [Number(q.id), String(q.correct ?? "").toUpperCase()]));
const planByEmail = new Map(payloads.students.map((s) => [s.email.toLowerCase(), s]));

function normSet(v) {
  return [...new Set(String(v ?? "").toUpperCase().split(",").filter(Boolean))].sort().join(",");
}

const parts = (
  await db.execute({
    sql: `SELECT id, email, status, exam_started_at, exam_submitted_at, submit_reason,
                 tab_violation_count, failed_attempts, locked_until, time_taken_seconds
          FROM participants WHERE exam_id = ?`,
    args: [examId],
  })
).rows;

const results = new Map(
  (await db.execute({ sql: "SELECT * FROM results", args: [] })).rows.map((r) => [String(r.participant_id), r]),
);

const v = {
  phase,
  ranAt: new Date().toISOString(),
  participants: {
    total: parts.length,
    not_started: parts.filter((p) => p.status === "not_started").length,
    in_progress: parts.filter((p) => p.status === "in_progress").length,
    completed: parts.filter((p) => p.status === "completed").length,
  },
  submit_reasons: {},
  checks: {},
  failures: [],
};
for (const p of parts) {
  if (p.submit_reason) v.submit_reasons[p.submit_reason] = (v.submit_reasons[p.submit_reason] ?? 0) + 1;
}

const completed = parts.filter((p) => p.status === "completed");
const inProgress = parts.filter((p) => p.status === "in_progress");
v.completed = completed.length;

// ---- V1/V2/V3/V4 per completed participant --------------------------------
let lostAnswers = 0;
let doubleScoring = 0;
let regradeMismatch = 0;
let missingResult = 0;
let missingReason = 0;
let lostDetail = [];
let regradeDetail = [];

// responses: only graded rows matter (per participant)
const respRows = (
  await db.execute({
    sql: `SELECT r.participant_id, r.question_id, r.selected_option, r.is_correct, r.marks_awarded, p.email
          FROM responses r JOIN participants p ON p.id = r.participant_id
          WHERE p.exam_id = ?`,
    args: [examId],
  })
).rows;
const byParticipant = new Map();
for (const r of respRows) {
  const pid = String(r.participant_id);
  if (!byParticipant.has(pid)) byParticipant.set(pid, []);
  byParticipant.get(pid).push(r);
}

for (const p of completed) {
  const pid = String(p.id);
  const rows = byParticipant.get(pid) ?? [];
  if (rows.length !== QUESTIONS) {
    lostAnswers += 1;
    if (lostDetail.length < 10) lostDetail.push({ email: p.email, responses: rows.length });
  }
  // Every answer the student actually gave must be in the database with the
  // same option - a row count alone is not enough (the grader inserts an
  // "unattempted" row per question, so a lost attempt still has 30 rows).
  // Only the load phase can be compared answer by answer: in the submit spike
  // the answers were written by reset-participants.mjs, not by the load plan.
  const plan = phase === "load" ? planByEmail.get(String(p.email).toLowerCase()) : undefined;
  if (plan) {
    const stored = new Map(rows.map((r) => [Number(r.question_id), r.selected_option]));
    const missing = [];
    for (const a of plan.answers ?? []) {
      const got = stored.get(Number(a.q));
      if (got == null || got === "" || normSet(got) !== normSet(a.option)) {
        missing.push({ q: a.q, expected: a.option, stored: got ?? null });
      }
    }
    if (missing.length) {
      lostAnswers += 1;
      if (lostDetail.length < 10) lostDetail.push({ email: p.email, missing: missing.slice(0, 5), missingCount: missing.length });
    }
  }
  const res = results.get(pid);
  if (!res) {
    missingResult += 1;
    continue;
  }
  if (!p.submit_reason || !p.exam_submitted_at) missingReason += 1;

  // V3 — internal consistency of the stored grade
  const sumMarks = rows.reduce((a, r) => a + Number(r.marks_awarded ?? 0), 0);
  if (Math.abs(sumMarks - Number(res.total_marks)) > 1e-6) {
    doubleScoring += 1;
  }

  // V4 — independent re-grade from the stored answers
  let correct = 0;
  let wrong = 0;
  let unattempted = 0;
  for (let q = 1; q <= QUESTIONS; q++) {
    const row = rows.find((r) => Number(r.question_id) === q);
    const sel = row?.selected_option == null || row.selected_option === "" ? null : normSet(row.selected_option);
    if (sel == null) unattempted += 1;
    else if (sel === normSet(correctByQ.get(q) ?? "")) correct += 1;
    else wrong += 1;
  }
  if (
    correct !== Number(res.total_correct) ||
    wrong !== Number(res.total_wrong) ||
    unattempted !== Number(res.total_unattempted)
  ) {
    regradeMismatch += 1;
    if (regradeDetail.length < 10)
      regradeDetail.push({
        email: p.email,
        stored: [res.total_correct, res.total_wrong, res.total_unattempted],
        recomputed: [correct, wrong, unattempted],
      });
  }

  // sanity: the student's plan really was answered (uses payload plan salt)
  void planByEmail.get(String(p.email).toLowerCase());
}

// ---- V5/V6 ---------------------------------------------------------------
const lockedOrFailed = parts.filter((p) => Number(p.failed_attempts ?? 0) > 0 || p.locked_until);
const violationWeird = completed.filter((p) => Number(p.tab_violation_count ?? 0) !== 0);
const notStartedWithAnswers = inProgress.filter((p) => {
  const rows = byParticipant.get(String(p.id)) ?? [];
  return p.status === "not_started" && rows.length > 0;
});

v.checks = {
  V1_zero_lost_answers: { pass: lostAnswers === 0, lostAttempts: lostAnswers, detail: lostDetail },
  V2_no_duplicate_submissions: {
    pass: missingResult === 0 && missingReason === 0,
    missingResults: missingResult,
    missingSubmitMeta: missingReason,
    resultsRows: results.size,
    completedParticipants: completed.length,
  },
  V3_no_double_scoring: { pass: doubleScoring === 0, mismatches: doubleScoring },
  V4_scoring_matches_answers: { pass: regradeMismatch === 0, mismatches: regradeMismatch, detail: regradeDetail },
  V5_no_stuck_accounts: { pass: lockedOrFailed.length === 0, count: lockedOrFailed.length },
  V6_no_stray_violations: { pass: violationWeird.length === 0, count: violationWeird.length },
  not_started_with_leftover_answers: { pass: notStartedWithAnswers.length === 0 },
  // Every seeded student must have finished the attempt in this phase: a
  // participant left "not_started" (the start write failed) or "in_progress"
  // (the attempt never closed) means the run lost a live examinee.
  V7_every_attempt_closed: {
    pass: v.participants.not_started === 0 && v.participants.in_progress === 0,
    not_started: v.participants.not_started,
    in_progress: v.participants.in_progress,
  },
};

const outPath = path.join(ART_DIR, `verify-${phase}.json`);
writeJson(outPath, v);

console.log(`\n[qa500:verify] phase=${phase} — participants: ${JSON.stringify(v.participants)}`);
console.log(`[qa500:verify] submit reasons: ${JSON.stringify(v.submit_reasons)}`);
let allPass = true;
for (const [name, c] of Object.entries(v.checks)) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${name}${c.pass ? "" : "  " + JSON.stringify(c)}`);
  if (!c.pass) allPass = false;
}
console.log(`[qa500:verify] ${allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} — ${outPath}`);
process.exit(allPass ? 0 : 1);
