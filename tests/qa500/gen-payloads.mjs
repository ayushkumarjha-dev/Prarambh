#!/usr/bin/env node
/**
 * QA-500 payload precompute — k6 can't serialize seroval cross-JSON, so every
 * request body is generated here offline with the real seroval +
 * tests/lib/serverfn.mjs (same bytes the browser sends).
 *
 *   node tests/qa500/gen-payloads.mjs
 *
 * Reads session tokens from the staging DB (service side), writes:
 *   tests/.artifacts/qa500/payloads-qa500.json   (canonical, gitignored)
 *   tests/qa500/k6/payloads-qa500.json           (k6 open() path, gitignored)
 *
 * Per student: login/brief/start/state/violation/submit bodies + 30 answer
 * bodies (every question answered — A/B/C/D rotation), so k6 does zero
 * serialization and grading load is maximal.
 */
import fs from "node:fs";
import path from "node:path";
import { fnId, serializeFnData, SERVER_FN_FILES } from "../lib/serverfn.mjs";
import {
  LOAD_SLUG,
  LOAD_QUESTIONS,
  LOAD_COUNT,
  LOAD_PASSWORD,
  loadEmail,
  nameFor,
  planLetter,
  PAYLOADS_PATH,
  K6_PAYLOAD_COPY,
  openDb,
  one,
} from "./lib/qa500.mjs";

const db = await openDb();
const exam = await one(db, "SELECT id, slug FROM exams WHERE slug = ?", [LOAD_SLUG]);
if (!exam) {
  console.error(`[qa500:payloads] exam ${LOAD_SLUG} not found — run tests/qa500/seed.mjs first.`);
  process.exit(1);
}

const rows = (
  await db.execute({
    sql: "SELECT email, session_token, status FROM participants WHERE exam_id = ?",
    args: [String(exam.id)],
  })
).rows;
const byEmail = new Map(rows.map((r) => [String(r.email).toLowerCase(), r]));

const fnIds = {
  getExamPublic: fnId(SERVER_FN_FILES.exam, "getExamPublic"),
  login: fnId(SERVER_FN_FILES.exam, "loginExamParticipant"),
  brief: fnId(SERVER_FN_FILES.exam, "getExamBrief"),
  getState: fnId(SERVER_FN_FILES.exam, "getExamState"),
  start: fnId(SERVER_FN_FILES.exam, "startExam"),
  save: fnId(SERVER_FN_FILES.exam, "saveAnswer"),
  violation: fnId(SERVER_FN_FILES.exam, "reportViolation"),
  submit: fnId(SERVER_FN_FILES.exam, "submitExam"),
};

const students = [];
for (let i = 1; i <= LOAD_COUNT; i++) {
  const email = loadEmail(i);
  const row = byEmail.get(email.toLowerCase());
  if (!row) throw new Error(`missing seeded participant ${email} — run tests/qa500/seed.mjs`);
  const token = String(row.session_token);
  const salt = email.length; // deterministic per-student rotation
  const answers = [];
  for (let q = 1; q <= LOAD_QUESTIONS; q++) {
    answers.push({
      q,
      option: planLetter(q, salt),
      body: await serializeFnData({
        slug: LOAD_SLUG,
        token,
        questionId: q,
        option: planLetter(q, salt),
      }),
    });
  }
  students.push({
    idx: i - 1,
    email,
    name: nameFor(email),
    token,
    loginBody: await serializeFnData({
      slug: LOAD_SLUG,
      name: nameFor(email),
      email,
      password: LOAD_PASSWORD,
    }),
    briefBody: await serializeFnData({ slug: LOAD_SLUG, token }),
    startBody: await serializeFnData({ slug: LOAD_SLUG, token }),
    stateBody: await serializeFnData({ slug: LOAD_SLUG, token }),
    violationBody: await serializeFnData({ slug: LOAD_SLUG, token }),
    submitBody: await serializeFnData({ slug: LOAD_SLUG, token, reason: "manual" }),
    timeoutSubmitBody: await serializeFnData({ slug: LOAD_SLUG, token, reason: "timeout" }),
    answers,
  });
  if (i % 100 === 0) console.log(`[qa500:payloads] ${i}/${LOAD_COUNT}`);
}

const out = {
  createdAt: new Date().toISOString(),
  meta: { slug: LOAD_SLUG, examId: String(exam.id), questions: LOAD_QUESTIONS, students: students.length },
  fnIds,
  publicBody: await serializeFnData({ slug: LOAD_SLUG }),
  students,
};
fs.mkdirSync(path.dirname(PAYLOADS_PATH), { recursive: true });
fs.writeFileSync(PAYLOADS_PATH, JSON.stringify(out));
fs.writeFileSync(K6_PAYLOAD_COPY, JSON.stringify(out)); // gitignored: contains tokens
console.log(`[qa500:payloads] DONE — ${students.length} students x ${LOAD_QUESTIONS} answers`);
console.log(`[qa500:payloads] -> ${PAYLOADS_PATH}`);
console.log(`[qa500:payloads] -> ${K6_PAYLOAD_COPY} (k6 open() path, gitignored)`);
