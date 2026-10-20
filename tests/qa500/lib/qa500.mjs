/**
 * Shared constants + helpers for the QA-500 test plan
 * (500 concurrent live users, anti-cheating & auto-submit verification).
 *
 * ALL data created by these scripts is marked:
 *   - exams:      slug LIKE 'qa500-%', subject 'qa500'
 *   - participants: group_name 'qa500*' , emails testNNN@example.com /
 *                   e2eNNN@example.com (reserved test domains)
 * so cleanup can be exact and can never touch real data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "qa500";
export const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const ART_DIR = path.join(ROOT, "tests", ".artifacts", "qa500");

// ------------------------------------------------------------- exam specs
export const LOAD_SLUG = "qa500-live";
export const E2E_SLUG = "qa500-e2e";
export const LOAD_QUESTIONS = 30;
export const LOAD_DURATION_MIN = 30;
export const E2E_QUESTIONS = 5;
export const E2E_DURATION_MIN = 10;
export const MARKS_CORRECT = 2;
export const MARKS_WRONG = -0.5;

// Known, fixed test passwords (test data — documented in tests/qa500/README.md).
export const LOAD_PASSWORD = "Qa500!Pass123";
export const E2E_PASSWORD = "E2e!Pass1234";

export const LOAD_COUNT = 500;
export const E2E_COUNT = 12; // e2e001..e2e012 — Playwright accounts
export const SMOKE_COUNT = 1; // smoke001 — protocol smoke flow

export function loadEmail(i) {
  return `test${String(i).padStart(3, "0")}@example.com`;
}
export function e2eEmail(i) {
  return `e2e${String(i).padStart(3, "0")}@example.com`;
}
export function smokeEmail(i) {
  return `smoke${String(i).padStart(3, "0")}@example.com`;
}
export function nameFor(email) {
  return `QA500 ${String(email).split("@")[0]}`;
}

/** Deterministic correct answer per question: A,B,C,D rotation. */
export function correctLetter(qid) {
  return ["A", "B", "C", "D"][(qid - 1) % 4];
}
/** Deterministic answer a load-test student picks (sometimes wrong). */
export function planLetter(qid, salt) {
  return ["A", "B", "C", "D"][(qid + salt) % 4];
}

/** question_sets.data document with `n` MCQs (ids 1..n). */
export function buildQuestionDoc(prefix, n) {
  const questions = [];
  for (let q = 1; q <= n; q++) {
    questions.push({
      id: q,
      topic: MARKER,
      subtopic: prefix,
      difficulty: "medium",
      qtype: "mcq",
      question: `QA500 ${prefix} question ${q}: which option is correct?`,
      option_a: `Option A for ${prefix} q${q}`,
      option_b: `Option B for ${prefix} q${q}`,
      option_c: `Option C for ${prefix} q${q}`,
      option_d: `Option D for ${prefix} q${q}`,
      correct: correctLetter(q),
    });
  }
  return {
    meta: {
      event: `QA500 ${prefix} exam`,
      organiser: "Prarambh QA",
      marks_correct: MARKS_CORRECT,
      marks_wrong: MARKS_WRONG,
      max_marks: n * MARKS_CORRECT,
      duration_minutes: prefix === "live" ? LOAD_DURATION_MIN : E2E_DURATION_MIN,
    },
    questions,
  };
}

/** Live window: started 15 minutes ago, open for 6 more hours. */
export function liveWindow() {
  const now = Date.now();
  return {
    starts_at: new Date(now - 15 * 60_000).toISOString(),
    ends_at: new Date(now + 6 * 3600_000).toISOString(),
  };
}

// ------------------------------------------------------------- artifacts
export const PAYLOADS_PATH = path.join(ART_DIR, "payloads-qa500.json");
export const MANIFEST_PATH = path.join(ART_DIR, "seed-manifest.json");
export const CREDENTIALS_PATH = path.join(ART_DIR, "seed-credentials.json");

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** k6 payload copy consumed by `open()` inside tests/qa500/k6/ (gitignored). */
export const K6_PAYLOAD_COPY = path.join(ROOT, "tests", "qa500", "k6", "payloads-qa500.json");

// ------------------------------------------------------------- db
export async function openDb() {
  const { loadTestEnv, assertNotProduction } = await import("../../lib/env.mjs");
  loadTestEnv();
  assertNotProduction(process.env.TURSO_DATABASE_URL);
  if (!process.env.TURSO_DATABASE_URL) {
    console.error("[qa500] Missing TURSO_DATABASE_URL — fill in .env.test.");
    process.exit(1);
  }
  const { createClient } = await import("@libsql/client");
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
}

export async function one(db, sql, args = []) {
  const rs = await db.execute({ sql, args });
  return rs.rows[0] ?? null;
}

/** Batch-execute `sql` with positional-arg arrays (chunks of `size`). */
export async function chunkExec(db, rows, sql, size = 50) {
  if (rows.length && !Array.isArray(rows[0])) {
    throw new Error("chunkExec expects rows as positional-arg ARRAYS (libSQL native panics on objects)");
  }
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    await db.batch(
      part.map((args) => ({ sql, args })),
      "write",
    );
  }
}
