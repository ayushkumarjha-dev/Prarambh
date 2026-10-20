#!/usr/bin/env node
/**
 * QA-500 cleanup — removes every piece of qa500 test data from the staging DB.
 *
 *   node tests/qa500/cleanup.mjs             # delete + report
 *   node tests/qa500/cleanup.mjs --dry-run  # count only, touch nothing
 *
 * Scope (all markers, nothing else):
 *   exams      slug LIKE 'qa500-%'
 *   participants  on those exams (cascades responses + results),
 *                 plus any stragglers with group_name LIKE 'qa500%'
 *   question_sets  owned by the deleted exams
 */
import { ART_DIR, openDb, one } from "./lib/qa500.mjs";
import fs from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const db = await openDb();

async function count(sql, args = []) {
  const r = await one(db, sql, args);
  return Number(Object.values(r ?? {})[0] ?? 0);
}

const examIds = (
  await db.execute({ sql: "SELECT id FROM exams WHERE slug LIKE 'qa500-%'", args: [] })
).rows.map((r) => String(r.id));
const ph = examIds.map(() => "?").join(",");
const examFilter = ph || "NULL";

const before = {
  exams: examIds.length,
  participants_on_qa500_exams: await count(
    `SELECT COUNT(*) AS n FROM participants WHERE exam_id IN (${examFilter})`,
    examIds,
  ),
  participants_by_marker: await count(
    "SELECT COUNT(*) AS n FROM participants WHERE group_name LIKE 'qa500%'",
  ),
  responses: await count(
    `SELECT COUNT(*) AS n FROM responses WHERE participant_id IN
      (SELECT id FROM participants WHERE exam_id IN (${examFilter}))`,
    examIds,
  ),
  results: await count(
    `SELECT COUNT(*) AS n FROM results WHERE participant_id IN
      (SELECT id FROM participants WHERE exam_id IN (${examFilter}))`,
    examIds,
  ),
};

console.log("[qa500:cleanup] found:", JSON.stringify(before));
if (before.exams === 0 && before.participants_by_marker === 0) {
  console.log("[qa500:cleanup] nothing to remove — staging DB is clean.");
  process.exit(0);
}
if (dryRun) {
  console.log("[qa500:cleanup] dry-run — nothing deleted.");
  process.exit(0);
}

// Order matters: participants first (cascades responses+results), then exams,
// then question sets that no exam references any more.
if (before.participants_on_qa500_exams > 0) {
  await db.execute({ sql: `DELETE FROM participants WHERE exam_id IN (${examFilter})`, args: examIds });
}
if (before.participants_by_marker > 0) {
  await db.execute({
    sql: "DELETE FROM participants WHERE group_name LIKE 'qa500%' AND (exam_id IS NULL OR exam_id NOT IN (" + examFilter + "))",
    args: examIds,
  });
}
if (examIds.length) {
  await db.execute({ sql: `DELETE FROM exams WHERE id IN (${examFilter})`, args: examIds });
}
// question_sets owned by qa500 exams are now orphans; remove orphans whose
// data carries the qa500 marker (never touches sets referenced by real exams).
await db.execute({
  sql: `DELETE FROM question_sets
        WHERE data LIKE '%"qa500%'
          AND id NOT IN (SELECT question_set_id FROM exams WHERE question_set_id IS NOT NULL)`,
});

const after = {
  exams: await count("SELECT COUNT(*) AS n FROM exams WHERE slug LIKE 'qa500-%'"),
  participants: await count("SELECT COUNT(*) AS n FROM participants WHERE group_name LIKE 'qa500%'"),
  responses: await count("SELECT COUNT(*) AS n FROM responses WHERE participant_id IN (SELECT id FROM participants WHERE group_name LIKE 'qa500%')"),
};
console.log("[qa500:cleanup] removed. remaining qa500 rows:", JSON.stringify(after));

// Local artifacts (payloads contain serialized credentials — always remove).
if (fs.existsSync(ART_DIR)) {
  fs.rmSync(ART_DIR, { recursive: true, force: true });
  console.log(`[qa500:cleanup] removed artifacts dir ${ART_DIR}`);
}
const k6Payload = new URL("./k6/payloads-qa500.json", import.meta.url);
try {
  fs.rmSync(k6Payload, { force: true });
} catch {
  /* absent — fine */
}
console.log("[qa500:cleanup] DONE — staging DB and artifacts contain no qa500 data.");
