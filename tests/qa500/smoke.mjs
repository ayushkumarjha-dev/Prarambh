#!/usr/bin/env node
/**
 * QA-500 protocol smoke — one complete real attempt over the SAME HTTP
 * protocol k6 uses (TanStack server-fns + seroval), against the staging
 * dev server (tests/.artifacts/dev-server.json / APP_URL from .env.test).
 *
 *   node tests/qa500/smoke.mjs
 *
 * Flow: public exam -> login -> brief -> start -> 5 answers (all correct)
 *       -> submit -> completed -> DB grading assertions.
 * Uses the dedicated smoke student (smoke001@example.com) so load/e2e
 * participants stay untouched. Non-zero exit on any failure.
 */
import {
  E2E_SLUG,
  E2E_QUESTIONS,
  E2E_PASSWORD,
  smokeEmail,
  nameFor,
  correctLetter,
  openDb,
  one,
  ART_DIR,
  readJson,
} from "./lib/qa500.mjs";
import { callServerFn, warmUpServerFns, readProdFnIds, useFnIds } from "../lib/serverfn.mjs";
import path from "node:path";

const base =
  process.env.APP_URL ??
  readJson(path.join(ART_DIR, "..", "dev-server.json"), null)?.baseUrl ??
  "http://localhost:5173";
const email = smokeEmail(1);
const fn = (name, data) => callServerFn(base, { fn: name, data });

// Register the server fns first (what a browser page-load would do) — the
// dev server's in-memory lookup is otherwise empty for API-style callers.
// A production build needs its own (SHA-256) fn ids instead.
const prodMode = (process.env.PROD || "0") === "1";
if (prodMode) useFnIds(readProdFnIds());
else await warmUpServerFns(base);

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const db = await openDb();
const exam = await one(db, "SELECT id FROM exams WHERE slug = ?", [E2E_SLUG]);
if (!exam) {
  console.error(`[smoke] exam ${E2E_SLUG} missing — run node tests/qa500/seed.mjs first.`);
  process.exit(1);
}
// Fresh attempt every run.
await db.execute({ sql: "DELETE FROM responses WHERE participant_id IN (SELECT id FROM participants WHERE lower(email)=lower(?))", args: [email] });
await db.execute({ sql: "DELETE FROM results WHERE participant_id IN (SELECT id FROM participants WHERE lower(email)=lower(?))", args: [email] });
await db.execute({
  sql: `UPDATE participants SET status='not_started', exam_started_at=NULL, exam_submitted_at=NULL,
        time_taken_seconds=NULL, submit_reason=NULL, tab_violation_count=0, failed_attempts=0,
        locked_until=NULL, name=? WHERE lower(email)=lower(?) AND exam_id=?`,
  args: [nameFor(email), email, String(exam.id)],
});

console.log(`[smoke] base=${base} student=${email} exam=${E2E_SLUG}`);

// 1. public info (no auth)
{
  const r = await fn("getExamPublic", { slug: E2E_SLUG });
  check("getExamPublic 200", r.status === 200 && !r.error, r.error?.message);
}

// 2. login -> token
let token = null;
{
  const r = await fn("loginExamParticipant", {
    slug: E2E_SLUG,
    name: nameFor(email),
    email,
    password: E2E_PASSWORD,
  });
  token = r.result?.token ?? null;
  check("login returns session token", r.status === 200 && !!token, r.error?.message);
  if (!token) process.exit(1);
}

// 3. brief before start
{
  const r = await fn("getExamBrief", { slug: E2E_SLUG, token });
  check(
    "brief: status not_started",
    r.status === 200 && r.result?.status === "not_started",
    `${r.result?.status ?? r.error?.message}`,
  );
}

// 4. start
{
  const r = await fn("startExam", { slug: E2E_SLUG, token });
  check("startExam ok", r.status === 200 && r.result?.ok === true, r.error?.message);
}

// 5. state: questions + server clock
{
  const r = await fn("getExamState", { slug: E2E_SLUG, token });
  const q = r.result?.questions ?? [];
  check(
    "state: in_progress with all questions",
    r.result?.status === "in_progress" && q.length === E2E_QUESTIONS && !!r.result?.examStartedAt,
    `status=${r.result?.status} questions=${q.length}`,
  );
}

// 6. answer every question (all correct by construction)
for (let q = 1; q <= E2E_QUESTIONS; q++) {
  const r = await fn("saveAnswer", {
    slug: E2E_SLUG,
    token,
    questionId: q,
    option: correctLetter(q),
  });
  if (r.result?.saved !== true) check(`saveAnswer q${q}`, false, r.error?.message);
}
{
  const r = await fn("getExamState", { slug: E2E_SLUG, token });
  const saved = Object.keys(r.result?.answers ?? {}).length;
  check("all answers echoed by state", saved === E2E_QUESTIONS, `saved=${saved}`);
}

// 7. submit
{
  const r = await fn("submitExam", { slug: E2E_SLUG, token, reason: "manual" });
  check("submitExam accepted", r.status === 200 && r.result?.submitted === true, r.error?.message);
}

// 8. state after submit + re-submit idempotency
{
  const r = await fn("getExamState", { slug: E2E_SLUG, token });
  check("state: completed, no questions leaked", r.result?.status === "completed" && (r.result?.questions ?? []).length === 0, `status=${r.result?.status}`);
  const again = await fn("submitExam", { slug: E2E_SLUG, token, reason: "manual" });
  check("second submit still ok (idempotent)", again.result?.submitted === true);
  const login2 = await fn("loginExamParticipant", {
    slug: E2E_SLUG,
    name: nameFor(email),
    email,
    password: E2E_PASSWORD,
  });
  check(
    "login after submit refused",
    String(login2.error?.message ?? "").includes("already submitted"),
    login2.error?.message,
  );
}

// 9. DB grading assertions (independent of the app layer)
{
  const p = await one(db, "SELECT * FROM participants WHERE lower(email)=lower(?) AND exam_id=?", [email, String(exam.id)]);
  const res = await one(db, "SELECT * FROM results WHERE participant_id = ?", [String(p.id)]);
  const graded = await one(db, "SELECT COUNT(*) AS n FROM responses WHERE participant_id=? AND is_correct IS NOT NULL", [String(p.id)]);
  check("participant completed / manual", p.status === "completed" && p.submit_reason === "manual", `${p.status}/${p.submit_reason}`);
  check("graded responses", Number(graded?.n) === E2E_QUESTIONS, `graded=${graded?.n}`);
  check(
    "results: all correct (marks 2 each)",
    res && Number(res.total_correct) === E2E_QUESTIONS && Number(res.total_wrong) === 0 && Number(res.total_unattempted) === 0 && Number(res.total_marks) === E2E_QUESTIONS * 2,
    res ? `correct=${res.total_correct} marks=${res.total_marks}` : "no results row",
  );
}

console.log(failures ? `[smoke] FAILED: ${failures} check(s)` : "[smoke] PASS — full attempt flow works end to end");
process.exit(failures ? 1 : 0);
