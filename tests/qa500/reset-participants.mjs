#!/usr/bin/env node
/**
 * QA-500 participant state reset between scenarios.
 *
 *   node tests/qa500/reset-participants.mjs --mode fresh
 *       all 500 load participants -> not_started, no answers/results
 *       (clean slate for the main 30-minute load run)
 *
 *   node tests/qa500/reset-participants.mjs --mode mid-exam
 *       all 500 -> in_progress, started 2 min ago, 30 answers already saved
 *       (worst case for the "500 submit at once" spike: full grading load)
 */
import { LOAD_SLUG, LOAD_COUNT, openDb, one } from "./lib/qa500.mjs";

const modeArg = process.argv.find((a) => a.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1] : "fresh";
if (!["fresh", "mid-exam"].includes(mode)) {
  console.error("usage: reset-participants.mjs --mode=fresh|mid-exam");
  process.exit(1);
}

const db = await openDb();
const exam = await one(db, "SELECT id FROM exams WHERE slug = ?", [LOAD_SLUG]);
if (!exam) {
  console.error(`[qa500:reset] exam ${LOAD_SLUG} not found — seed first.`);
  process.exit(1);
}
const examId = String(exam.id);
const ids = (await db.execute({ sql: "SELECT id FROM participants WHERE exam_id = ?", args: [examId] })).rows.map(
  (r) => String(r.id),
);
console.log(`[qa500:reset] ${ids.length} participants on ${LOAD_SLUG} -> ${mode}`);

// Wipe attempt state (answers/results) for everyone first.
for (let i = 0; i < ids.length; i += 100) {
  const part = ids.slice(i, i + 100);
  const ph = part.map(() => "?").join(",");
  await db.execute({ sql: `DELETE FROM responses WHERE participant_id IN (${ph})`, args: part });
  await db.execute({ sql: `DELETE FROM results WHERE participant_id IN (${ph})`, args: part });
}

if (mode === "fresh") {
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const ph = part.map(() => "?").join(",");
    await db.execute({
      sql: `UPDATE participants SET status='not_started', exam_started_at=NULL, exam_submitted_at=NULL,
            time_taken_seconds=NULL, submit_reason=NULL, tab_violation_count=0,
            failed_attempts=0, locked_until=NULL WHERE id IN (${ph})`,
      args: part,
    });
  }
  console.log("[qa500:reset] DONE — all participants not_started, zero responses/results.");
  process.exit(0);
}

// mid-exam: everyone mid-attempt with 30 saved answers (max grading load).
const startedAt = new Date(Date.now() - 120_000).toISOString();
const now = new Date().toISOString();
for (let i = 0; i < ids.length; i += 25) {
  const part = ids.slice(i, i + 25);
  const stmts = [];
  for (const id of part) {
    const salt = id.length; // any deterministic-ish rotation
    stmts.push({
      sql: `UPDATE participants SET status='in_progress', exam_started_at=?, exam_submitted_at=NULL,
            time_taken_seconds=NULL, submit_reason=NULL, tab_violation_count=0,
            failed_attempts=0, locked_until=NULL WHERE id=?`,
      args: [startedAt, id],
    });
    for (let q = 1; q <= 30; q++) {
      const letters = ["A", "B", "C", "D"];
      stmts.push({
        sql: `INSERT INTO responses (id, participant_id, question_id, selected_option, is_correct, marks_awarded, updated_at)
              VALUES (?, ?, ?, ?, NULL, 0, ?)`,
        args: [crypto.randomUUID(), id, q, letters[(q + salt) % 4], now],
      });
    }
  }
  await db.batch(stmts, "write");
  if ((i + part.length) % 100 === 0) console.log(`[qa500:reset]   ${i + part.length}/${ids.length}`);
}
console.log(`[qa500:reset] DONE — ${ids.length} participants in_progress with 30 answers each (started 2 min ago).`);
console.log(`[qa500:reset] expected participants: ${LOAD_COUNT}.`);
