/**
 * QA-500 · Auto-submit behaviour — all four required triggers:
 *   (1) timer reaches zero          (server-side, source of truth)
 *   (2) manual submit + confirm popup
 *   (3) violation threshold         (covered in proctoring/mobile specs)
 *   (4) offline submit              (edge-cases spec — documents the gap)
 * plus: after submission the exam can never be re-opened or re-submitted
 * (refresh, back navigation, second device, raw API) and re-submission never
 * double-scores.
 */
import { test, expect } from "@playwright/test";
import {
  SLUG,
  QUESTIONS,
  FullscreenUnavailable,
  resetStudent,
  startExamThroughUI,
  clickOption,
  answerSaved,
  responseCount,
  participantRow,
  resultRow,
  expectEventually,
  forceExpired,
  gotoLastQuestion,
  submitViaUI,
  apiCall,
} from "./helpers";

async function startOrSkip(page: Parameters<typeof startExamThroughUI>[0], email: string) {
  await startExamThroughUI(page, email).catch((e) => {
    if (e instanceof FullscreenUnavailable) test.skip(true, e.message);
    throw e;
  });
}

test.describe("auto-submit", () => {
  test("timer reaches zero -> server auto-submits, saved answers keep their marks", async ({
    page,
  }) => {
    const email = "e2e007@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    await clickOption(page, "A"); // correct letter for q1
    await expectEventually(() => answerSaved(email, 1), "q1 saved");

    // Fast-forward the server clock past the 10-minute duration.
    await forceExpired(email);
    await page.reload();

    // Server-side enforcement runs during the state fetch: completed → redirect.
    await page.waitForURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 25000 });
    await expect(page.getByRole("heading", { name: "Your test has been submitted" })).toBeVisible();

    await expectEventually(async () => {
      const p = await participantRow(email);
      return p?.["status"] === "completed" && p?.["submit_reason"] === "timeout";
    }, "submit_reason=timeout (server clock is the source of truth)");

    // Zero lost answers: the pre-expiry answer was graded, rest unattempted.
    expect(await answerSaved(email, 1)).toBe(true);
    const res = await resultRow(email);
    expect(Number(res!["total_correct"])).toBe(1);
    expect(Number(res!["total_unattempted"])).toBe(QUESTIONS - 1);
    expect(Number(res!["total_correct"]) + Number(res!["total_wrong"]) + Number(res!["total_unattempted"])).toBe(
      QUESTIONS,
    );
  });

  test("manual submit asks for confirmation; cancel keeps the exam open, confirm submits", async ({
    page,
  }) => {
    const email = "e2e008@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    await gotoLastQuestion(page);

    // 1st click → popup → "Keep working" cancels (exam still open).
    await submitViaUI(page, { cancelFirst: true });
    await expect(page.getByText(`Question ${QUESTIONS} of ${QUESTIONS}`)).toBeVisible();
    expect((await participantRow(email))?.["status"]).toBe("in_progress");
    expect(await responseCount(email)).toBe(0);

    // Answer the last question, then confirm submission for real.
    await clickOption(page, "A"); // correct letter for q5 is A (rotation (5-1)%4)
    await expectEventually(() => answerSaved(email, QUESTIONS), "last answer saved");
    await submitViaUI(page);
    await expect(page.getByRole("heading", { name: "Your test has been submitted" })).toBeVisible();

    await expectEventually(async () => {
      const p = await participantRow(email);
      return p?.["status"] === "completed" && p?.["submit_reason"] === "manual";
    }, "submit_reason=manual");
    const res = await resultRow(email);
    expect(Number(res!["total_correct"]) + Number(res!["total_wrong"]) + Number(res!["total_unattempted"])).toBe(
      QUESTIONS,
    );
    expect(Number(res!["total_correct"])).toBe(1); // q5 answer graded exactly once
  });

  test("after submission: refresh, back navigation, second device and raw API are all locked out; re-submit never double-scores", async ({
    page,
    browser,
  }) => {
    const email = "e2e009@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);
    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "q1 saved");
    await gotoLastQuestion(page);
    await submitViaUI(page);
    await expect(page.getByRole("heading", { name: "Your test has been submitted" })).toBeVisible();

    const before = await resultRow(email);
    expect(before).not.toBeNull();

    // (a) Refresh keeps the confirmation page — no way back into the exam.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your test has been submitted" })).toBeVisible();

    // (b) Direct navigation to the exam: session was cleared → login page.
    await page.goto(`/exam/${SLUG}/start`);
    await page.waitForURL(new RegExp(`/exam/${SLUG}$`), { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Student login" })).toBeVisible();

    // (c) Logging in again is refused.
    await page.locator("#name").fill(`QA500 ${email.split("@")[0]}`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("E2e!Pass1234");
    await page.getByRole("button", { name: "Continue to instructions" }).click();
    await expect(page.getByText("You have already submitted this exam.")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(new RegExp(`/exam/${SLUG}$`));

    // (d) Second device (fresh context, same credentials) is refused too.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(`/exam/${SLUG}`);
    await page2.locator("#name").fill(`QA500 ${email.split("@")[0]}`);
    await page2.locator("#email").fill(email);
    await page2.locator("#password").fill("E2e!Pass1234");
    await page2.getByRole("button", { name: "Continue to instructions" }).click();
    await expect(page2.getByText("You have already submitted this exam.")).toBeVisible({ timeout: 10000 });
    await ctx2.close();

    // (e) Raw API: start refused, submit idempotent → results row unchanged.
    const row = await participantRow(email);
    const token = String(row!["session_token"]);
    const start = await apiCall("startExam", { slug: SLUG, token });
    expect(String(start.error?.message ?? "")).toContain("already submitted");
    const sub1 = await apiCall("submitExam", { slug: SLUG, token, reason: "manual" });
    const sub2 = await apiCall("submitExam", { slug: SLUG, token, reason: "manual" });
    expect(sub1.result).toEqual({ submitted: true });
    expect(sub2.result).toEqual({ submitted: true });
    const after = await resultRow(email);
    expect(after).toEqual(before); // zero duplicate submissions / double scoring
  });
});
