/**
 * QA-500 Playwright helpers — staging DB access + real UI flows.
 *
 * Staging only: DB comes from .env.test (safety rule 0), base URL from
 * tests/.artifacts/dev-server.json (npm run dev:test).
 *
 * UI flows mirror the actual app:
 *   /exam/$slug            login form (#name/#email/#password)
 *   /exam/$slug/instructions  checkbox + "Start the exam" (requests fullscreen)
 *   /exam/$slug/start       questions "Question N of 5", options button.min-h-16,
 *                           "Submit Test" + confirm modal, violation overlays
 */
import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type InValue } from "@libsql/client";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SLUG = "qa500-e2e";
export const QUESTIONS = 5;
export const DURATION_MIN = 10;
export const PASSWORD = "E2e!Pass1234";

export function emailFor(n: number): string {
  return `e2e${String(n).padStart(3, "0")}@example.com`;
}
export function nameFor(email: string): string {
  return `QA500 ${email.split("@")[0]}`;
}

/** Thrown when the browser refuses the Fullscreen API (headless/old browser). */
export class FullscreenUnavailable extends Error {}

// ------------------------------------------------------------------ DB
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

let _db: Client | null = null;
export function db(): Client {
  if (_db) return _db;
  const env = parseEnvFile(path.join(ROOT, ".env.test"));
  const url = env["TURSO_DATABASE_URL"];
  if (!url) throw new Error(".env.test is missing TURSO_DATABASE_URL (staging rule 0)");
  _db = createClient({ url, authToken: env["TURSO_AUTH_TOKEN"] || undefined });
  return _db;
}

async function q(sql: string, args: InValue[] = []) {
  const r = await db().execute({ sql, args });
  return r.rows;
}

/** Fresh attempt for a student (also restores the seeded display name). */
export async function resetStudent(email: string): Promise<number> {
  const rows = await q(
    "SELECT id FROM participants WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?)",
    [email, SLUG],
  );
  for (const r of rows) {
    const id = String(r["id"]);
    await q("DELETE FROM responses WHERE participant_id=?", [id]);
    await q("DELETE FROM results WHERE participant_id=?", [id]);
    await q(
      `UPDATE participants SET status='not_started', exam_started_at=NULL, exam_submitted_at=NULL,
       time_taken_seconds=NULL, submit_reason=NULL, tab_violation_count=0, failed_attempts=0,
       locked_until=NULL, name=? WHERE id=?`,
      [nameFor(email), id],
    );
  }
  return rows.length;
}

export async function participantRow(email: string): Promise<Record<string, unknown> | null> {
  const rows = await q(
    `SELECT p.* FROM participants p
     WHERE lower(p.email)=lower(?) AND p.exam_id=(SELECT id FROM exams WHERE slug=?)`,
    [email, SLUG],
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

export async function answerSaved(email: string, qid: number): Promise<boolean> {
  const rows = await q(
    `SELECT selected_option FROM responses
     WHERE participant_id=(SELECT id FROM participants WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?))
       AND question_id=?`,
    [email, SLUG, qid],
  );
  const r = rows[0];
  return Boolean(r && r["selected_option"] != null && String(r["selected_option"]) !== "");
}

/** Stored answer letter(s) for one question (null when never saved). */
export async function answerValue(email: string, qid: number): Promise<string | null> {
  const rows = await q(
    `SELECT selected_option FROM responses
     WHERE participant_id=(SELECT id FROM participants WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?))
       AND question_id=?`,
    [email, SLUG, qid],
  );
  const v = rows[0]?.["selected_option"];
  return v == null || String(v) === "" ? null : String(v);
}

export async function responseCount(email: string): Promise<number> {
  const rows = await q(
    `SELECT COUNT(*) AS n FROM responses
     WHERE participant_id=(SELECT id FROM participants WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?))`,
    [email, SLUG],
  );
  return Number(rows[0]?.["n"] ?? 0);
}

/** Graded result row for a student (null before submission). */
export async function resultRow(email: string): Promise<Record<string, unknown> | null> {
  const rows = await q(
    `SELECT r.* FROM results r
     WHERE r.participant_id=(SELECT id FROM participants WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?))`,
    [email, SLUG],
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/** Poll a DB predicate until true (throws with `label` after timeout). */
export async function expectEventually(
  fn: () => Promise<boolean>,
  label: string,
  timeoutMs = 15000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e; // transient SQLITE_BUSY etc.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`expectEventually timed out: ${label}${lastErr ? ` (last error: ${lastErr})` : ""}`);
}

/** Server-authoritative timer: push the start time past the exam duration. */
export async function forceExpired(email: string): Promise<void> {
  const started = new Date(Date.now() - (DURATION_MIN * 60 + 5) * 1000).toISOString();
  await q(
    `UPDATE participants SET status='in_progress', exam_started_at=?
     WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?)`,
    [started, email, SLUG],
  );
}

export async function backdateStart(email: string, seconds: number): Promise<void> {
  const started = new Date(Date.now() - seconds * 1000).toISOString();
  await q(
    `UPDATE participants SET status='in_progress', exam_started_at=?
     WHERE lower(email)=lower(?) AND exam_id=(SELECT id FROM exams WHERE slug=?)`,
    [started, email, SLUG],
  );
}

// ------------------------------------------------------------------ API
export async function apiBaseUrl(): Promise<string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "tests", ".artifacts", "dev-server.json"), "utf8")).baseUrl;
  } catch {
    return process.env.APP_URL ?? "http://localhost:5173";
  }
}

let warmed: Promise<void> | undefined;

/** Raw server-fn call over HTTP (same protocol k6 uses). */
export async function apiCall(fn: string, data: Record<string, unknown>) {
  const { callServerFn, warmUpServerFns } = await import("../../lib/serverfn.mjs");
  const base = await apiBaseUrl();
  // Register the server fns once per process, exactly like a page load would
  // (the dev lookup table is in-memory; API-style callers never load a page).
  warmed ??= warmUpServerFns(base).catch((e) => {
    warmed = undefined; // allow a retry on the next call
    throw e;
  });
  await warmed;
  return callServerFn(base, { fn, data });
}

// ------------------------------------------------------------------ UI flows
export async function passMobileNotice(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: "Continue on this phone" });
  const nameField = page.locator("#name");
  // The login page is client-rendered (ssr: false): during the first frames the
  // document is empty, so "button not found" does NOT mean "not a phone".
  // Wait (briefly) until either the notice or the login form has rendered —
  // on pages where neither can appear this must not stall the suite.
  await Promise.race([
    btn.waitFor({ state: "visible", timeout: 3500 }),
    nameField.waitFor({ state: "visible", timeout: 3500 }),
  ]).catch(() => {});

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await btn.count()) === 0) return;
    if (!(await btn.isVisible().catch(() => false))) return;
    await btn.click({ timeout: 5000 }).catch(() => {});
    try {
      await Promise.race([
        btn.waitFor({ state: "hidden", timeout: 3000 }),
        nameField.waitFor({ state: "visible", timeout: 3000 }),
      ]);
      return;
    } catch {
      await page.waitForTimeout(400);
    }
  }
}

export async function loginToExam(page: Page, email: string): Promise<void> {
  await page.goto(`/exam/${SLUG}`);
  await passMobileNotice(page);
  await page.locator("#name").fill(nameFor(email));
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue to instructions" }).click();
  await page.waitForURL(new RegExp(`/exam/${SLUG}/instructions`), { timeout: 20000 });
  await passMobileNotice(page);
}

/**
 * Tick the agreement + click "Start the exam". On desktop browsers this
 * requests fullscreen; if the browser refuses, throws FullscreenUnavailable
 * (tests skip instead of failing on an environment limitation).
 */
export async function acceptInstructionsAndStart(page: Page): Promise<void> {
  await page.getByRole("checkbox").first().click();
  await page.getByRole("button", { name: "Start the exam" }).click();
  try {
    await page.waitForURL(new RegExp(`/exam/${SLUG}/start`), { timeout: 15000 });
  } catch {
    const err = page.getByText(/Full-screen was blocked|Full-screen could not be started/);
    if (await err.isVisible().catch(() => false)) {
      throw new FullscreenUnavailable("browser refused fullscreen — environment limitation");
    }
    throw new Error("exam did not navigate to /start");
  }
  await passMobileNotice(page);
  await expect(page.getByText(`Question 1 of ${QUESTIONS}`)).toBeVisible({ timeout: 20000 });
  // Desktop: if the fullscreen gate is up (FS lost on navigation), try once.
  const gate = page.getByText("Return to full-screen to continue");
  if (await gate.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.getByRole("button", { name: "Return to Full-Screen" }).click();
    if (await gate.isVisible({ timeout: 2000 }).catch(() => false)) {
      throw new FullscreenUnavailable("could not re-enter fullscreen");
    }
  }
}

export async function startExamThroughUI(page: Page, email: string): Promise<void> {
  await loginToExam(page, email);
  await acceptInstructionsAndStart(page);
}

export async function clickOption(page: Page, letter: "A" | "B" | "C" | "D"): Promise<void> {
  await page
    .locator("button.min-h-16")
    .filter({ hasText: new RegExp(`^${letter}`) })
    .first()
    .click();
}

/** Header countdown (MM:SS) as seconds. */
export async function clockSeconds(page: Page): Promise<number> {
  const txt = await page.locator("header span.font-mono").first().innerText();
  const m = txt.trim().match(/^(\d+):(\d{2})$/);
  if (!m) throw new Error(`cannot parse clock text: "${txt}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---- violation triggers (deterministic, headless-safe) -----------------
export async function fireBlur(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
}
export async function fireHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    delete (document as { visibilityState?: unknown }).visibilityState;
  });
}
export async function fireResize(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
}
export async function fireOrientationChange(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
}
export async function fireContextMenu(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("contextmenu", { cancelable: true })));
}
/** Real Fullscreen API exit (requires an actually-fullscreen page). */
export async function exitFullscreenNow(page: Page): Promise<void> {
  await page.evaluate(() => document.exitFullscreen().catch(() => {}));
  await page.waitForTimeout(400);
}

// ---- submit ------------------------------------------------------------
/** Click the in-flow "Submit Test" (on the last question). Returns after modal interactions. */
export async function submitViaUI(page: Page, opts: { cancelFirst?: boolean } = {}): Promise<void> {
  await page.getByRole("button", { name: "Submit Test" }).first().click();
  const modal = page.getByRole("heading", { name: "Submit your test?" });
  await expect(modal).toBeVisible();
  if (opts.cancelFirst) {
    await page.getByRole("button", { name: "Keep working" }).click();
    await expect(modal).toBeHidden();
    return;
  }
  await modal.locator("xpath=..").getByRole("button", { name: "Submit Test" }).click();
  await page.waitForURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 25000 });
}

export async function gotoLastQuestion(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open question palette" }).click();
  await page.getByRole("button", { name: String(QUESTIONS), exact: true }).click();
  await expect(page.getByText(`Question ${QUESTIONS} of ${QUESTIONS}`)).toBeVisible();
}

/** Jump to a question through the palette (no auto-advance exists in the app). */
export async function gotoQuestion(page: Page, n: number): Promise<void> {
  await page.getByRole("button", { name: "Open question palette" }).click();
  await page.getByRole("button", { name: String(n), exact: true }).click();
  await expect(page.getByText(`Question ${n} of ${QUESTIONS}`)).toBeVisible();
}
