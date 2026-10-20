#!/usr/bin/env node
/**
 * QA-500 seed — staging test data ONLY (never production: tests/lib/env.mjs guard).
 *
 *   node tests/qa500/seed.mjs [--dry-run]
 *
 * Creates (idempotent — re-running resets everything it owns):
 *   - exam "qa500-live": 30 MCQs, 30 minutes, status live, scheduled window
 *   - exam "qa500-e2e":   5 MCQs, 10 minutes (Playwright specs)
 *   - 500 load participants  test001@example.com .. test500@example.com
 *     password: Qa500!Pass123   group_name: qa500
 *   -  12 e2e participants    e2e001@example.com .. e2e012@example.com
 *     password: E2e!Pass1234    group_name: qa500-e2e
 *   -   1 smoke participant   smoke001@example.com (protocol smoke flow)
 *
 * Everything is marked (slug prefix qa500-, group_name qa500*) so
 * tests/qa500/cleanup.mjs can remove it precisely.
 * Credentials are written ONLY to the gitignored
 * tests/.artifacts/qa500/seed-credentials.json — never printed.
 */
import {
  LOAD_SLUG,
  E2E_SLUG,
  LOAD_QUESTIONS,
  E2E_QUESTIONS,
  LOAD_DURATION_MIN,
  E2E_DURATION_MIN,
  MARKS_CORRECT,
  MARKS_WRONG,
  LOAD_COUNT,
  E2E_COUNT,
  SMOKE_COUNT,
  LOAD_PASSWORD,
  E2E_PASSWORD,
  loadEmail,
  e2eEmail,
  smokeEmail,
  nameFor,
  buildQuestionDoc,
  liveWindow,
  writeJson,
  MANIFEST_PATH,
  CREDENTIALS_PATH,
  openDb,
  one,
  chunkExec,
} from "./lib/qa500.mjs";

const dryRun = process.argv.includes("--dry-run");
const BCRYPT_ROUNDS = 10; // matches src/lib/admin.functions.ts hashPassword()

if (dryRun) {
  const bcryptMod = await import("bcryptjs");
  const bcrypt = bcryptMod.default ?? bcryptMod;
  const probe = await bcrypt.hash("qa500-probe", BCRYPT_ROUNDS);
  if (!probe.startsWith("$2")) throw new Error("bcrypt self-check failed");
  console.log(`[qa500:seed] dry-run OK — bcrypt works, NO database touched.`);
  console.log(`[qa500:seed] would create: ${LOAD_SLUG} (${LOAD_QUESTIONS}q/${LOAD_DURATION_MIN}min),`);
  console.log(`[qa500:seed]                  ${E2E_SLUG} (${E2E_QUESTIONS}q/${E2E_DURATION_MIN}min),`);
  console.log(`[qa500:seed] participants: ${LOAD_COUNT} load + ${E2E_COUNT} e2e + ${SMOKE_COUNT} smoke`);
  process.exit(0);
}

const bcryptMod = await import("bcryptjs");
const bcrypt = bcryptMod.default ?? bcryptMod;
const db = await openDb();

// 0. Sanity: migrations applied?
try {
  await db.execute("SELECT id FROM exams LIMIT 1");
} catch (e) {
  console.error(`[qa500:seed] Cannot query exams: ${e.message}`);
  console.error("[qa500:seed] Run `npm run db:migrate` against the staging DB first.");
  process.exit(1);
}

// 1. Remove anything a previous qa500 seed created (exact + cascade).
const oldExams = (
  await db.execute({ sql: "SELECT id, question_set_id FROM exams WHERE slug LIKE 'qa500-%'", args: [] })
).rows;
if (oldExams.length) {
  const examIds = oldExams.map((r) => String(r.id));
  const setIds = oldExams.map((r) => r.question_set_id).filter(Boolean).map(String);
  const ph = examIds.map(() => "?").join(",");
  await db.execute({ sql: `DELETE FROM participants WHERE exam_id IN (${ph})`, args: examIds }); // cascades responses+results
  await db.execute({ sql: `DELETE FROM exams WHERE id IN (${ph})`, args: examIds });
  if (setIds.length) {
    const sph = setIds.map(() => "?").join(",");
    await db.execute({ sql: `DELETE FROM question_sets WHERE id IN (${sph})`, args: setIds });
  }
  console.log(`[qa500:seed] removed previous qa500 data (${oldExams.length} exams)`);
}

// 2. Question sets + exams.
const w = liveWindow();
const specs = [
  {
    slug: LOAD_SLUG,
    title: "QA500 Load Exam — 30 MCQ / 30 min",
    subject: "qa500",
    duration: LOAD_DURATION_MIN,
    questions: LOAD_QUESTIONS,
    doc: buildQuestionDoc("live", LOAD_QUESTIONS),
  },
  {
    slug: E2E_SLUG,
    title: "QA500 E2E Exam — 5 MCQ / 10 min",
    subject: "qa500-e2e",
    duration: E2E_DURATION_MIN,
    questions: E2E_QUESTIONS,
    doc: buildQuestionDoc("e2e", E2E_QUESTIONS),
  },
];

const examRows = [];
for (const spec of specs) {
  const setId = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO question_sets (id, data, is_active, created_at) VALUES (?, ?, 0, ?)",
    args: [setId, JSON.stringify(spec.doc), new Date().toISOString()],
  });
  const examId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO exams (id, slug, title, subject, description, duration_minutes,
          marks_correct, marks_wrong, total_marks, passing_marks, status, starts_at, ends_at,
          is_enabled, question_set_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, 1, ?, ?)`,
    args: [
      examId,
      spec.slug,
      spec.title,
      spec.subject,
      "qa500 staging fixture — safe to delete",
      spec.duration,
      MARKS_CORRECT,
      MARKS_WRONG,
      spec.questions * MARKS_CORRECT,
      Math.round(spec.questions * MARKS_CORRECT * 0.4),
      w.starts_at,
      w.ends_at,
      setId,
      new Date().toISOString(),
    ],
  });
  examRows.push({ ...spec, id: examId, setId });
  console.log(`[qa500:seed] exam ${spec.slug}: ${spec.questions} questions, ${spec.duration} min, live`);
}
const loadExam = examRows.find((e) => e.slug === LOAD_SLUG);
const e2eExam = examRows.find((e) => e.slug === E2E_SLUG);

// 3. Participants (bcrypt cost 10 — same as the app's own password hashing).
const pools = [
  {
    exam: loadExam,
    group: "qa500",
    password: LOAD_PASSWORD,
    people: Array.from({ length: LOAD_COUNT }, (_, i) => ({
      n: i + 1,
      email: loadEmail(i + 1),
    })),
  },
  {
    exam: e2eExam,
    group: "qa500-e2e",
    password: E2E_PASSWORD,
    people: Array.from({ length: E2E_COUNT }, (_, i) => ({
      n: i + 1,
      email: e2eEmail(i + 1),
    })),
  },
  {
    exam: e2eExam,
    group: "qa500-smoke",
    password: E2E_PASSWORD,
    people: Array.from({ length: SMOKE_COUNT }, (_, i) => ({
      n: i + 1,
      email: smokeEmail(i + 1),
    })),
  },
];

const creds = { createdAt: new Date().toISOString(), note: "SECRET — gitignored. Never print." };
const manifest = { createdAt: new Date().toISOString(), exams: [], counts: {} };
let total = 0;
for (const pool of pools) {
  console.log(`[qa500:seed] ${pool.people.length} participants on ${pool.exam.slug} (bcrypt ${BCRYPT_ROUNDS} — takes a minute)…`);
  const rows = [];
  let done = 0;
  for (const p of pool.people) {
    const hash = await bcrypt.hash(pool.password, BCRYPT_ROUNDS);
    rows.push([
      crypto.randomUUID(), // id
      nameFor(p.email), // name
      p.email, // email
      crypto.randomUUID(), // session_token
      pool.exam.setId, // question_set_id
      pool.exam.id, // exam_id
      new Date().toISOString(), // created_at
      "", // phone
      "", // roll_no
      pool.group, // group_name
      hash, // password_hash
    ]);
    done += 1;
    if (done % 100 === 0) console.log(`[qa500:seed]   ${done}/${pool.people.length}`);
  }
  await chunkExec(
    db,
    rows,
    `INSERT INTO participants (id, name, email, session_token, question_set_id, exam_id,
      created_at, tab_violation_count, status, phone, roll_no, group_name, is_active,
      password_salt, password_hash, failed_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'not_started', ?, ?, ?, 1, 'bcrypt', ?, 0)`,
  );
  total += rows.length;
  creds[pool.group] = { email_domain: "(fixed per-user)", password: pool.password, count: rows.length };
  manifest.exams.push({ slug: pool.exam.slug, id: pool.exam.id, questionSetId: pool.exam.setId });
  manifest.counts[pool.group] = rows.length;
  console.log(`[qa500:seed]   ready: ${rows.length}`);
}

writeJson(MANIFEST_PATH, manifest);
writeJson(CREDENTIALS_PATH, creds);
console.log(`[qa500:seed] DONE — ${total} participants.`);
console.log(`[qa500:seed] manifest:    ${MANIFEST_PATH}`);
console.log(`[qa500:seed] credentials: ${CREDENTIALS_PATH} (gitignored; passwords: load=${LOAD_PASSWORD}, e2e=${E2E_PASSWORD})`);
console.log("[qa500:seed] next: node tests/qa500/gen-payloads.mjs && npm run dev:test");
