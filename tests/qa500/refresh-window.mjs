/**
 * Refresh the QA-500 fixture exam windows.
 *
 * Why: seed.mjs opens both fixtures for 6 hours. If the suite is re-run a day
 * later, the window has closed — logins are refused with "exam closed" while
 * mid-exam resumes (getState / submit) still work. That produces confusing
 * false-negative results (e.g. recovery scenario "pre-outage login 0/10").
 * Run this before a later session (or re-seed from scratch).
 *
 *   node tests/qa500/refresh-window.mjs            # +24h
 *   node tests/qa500/refresh-window.mjs --hours=6  # custom
 *
 * Test data only — no app code touched.
 */
import { openDb, LOAD_SLUG, E2E_SLUG } from "./lib/qa500.mjs";

const hours = Number((process.argv.find((a) => a.startsWith("--hours=")) || "").split("=")[1] || 24);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error("[qa500:window] --hours must be a positive number");
  process.exit(1);
}

const db = await openDb();
const now = Date.now();
const starts_at = new Date(now - 60 * 60_000).toISOString();
const ends_at = new Date(now + hours * 3600_000).toISOString();

for (const slug of [LOAD_SLUG, E2E_SLUG]) {
  await db.execute({
    sql: "UPDATE exams SET starts_at = ?, ends_at = ?, status = 'live', is_enabled = 1 WHERE slug = ?",
    args: [starts_at, ends_at, slug],
  });
}

const rows = (
  await db.execute("SELECT slug, starts_at, ends_at, status FROM exams WHERE slug LIKE 'qa500-%' ORDER BY slug")
).rows;
for (const r of rows) {
  console.log(`[qa500:window] ${r.slug}: ${r.starts_at} -> ${r.ends_at} (${r.status})`);
}
console.log(`[qa500:window] DONE — fixtures open for the next ${hours}h.`);
