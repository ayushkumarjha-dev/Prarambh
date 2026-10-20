/**
 * QA-500 · Phone proctoring (Android Chrome / iPhone Safari emulation).
 *
 * Phones cannot use the Fullscreen lock (iPhone Safari has no Element
 * requestFullscreen at all) — the app's fallback arms violation detection
 * immediately. These tests cover the phone path: fairness notice, app-switch
 * / notification-shade / screen-lock detection, auto-submit at 3 strikes, and
 * the split-screen detection gap.
 */
import { test, expect } from "@playwright/test";
import {
  SLUG,
  QUESTIONS,
  resetStudent,
  startExamThroughUI,
  loginToExam,
  acceptInstructionsAndStart,
  passMobileNotice,
  clickOption,
  answerSaved,
  participantRow,
  resultRow,
  expectEventually,
  fireBlur,
  fireHidden,
  fireOrientationChange,
} from "./helpers";


test.describe("phone proctoring", () => {
  // Firefox/WebKit hang on teardown of a context created for a skipped test,
  // so gate at describe level (before any fixture is built).
  test.skip(({ isMobile }) => !isMobile, "phone-only scenario");
  test("phone fairness notice appears, then the exam starts WITHOUT a fullscreen lock", async ({
    page,
  }) => {
    const email = "e2e004@example.com";
    await resetStudent(email);

    await page.goto(`/exam/${SLUG}`);
    await expect(page.getByRole("heading", { name: "You're on a phone" })).toBeVisible();
    await passMobileNotice(page);

    await page.locator("#name").fill(`QA500 ${email.split("@")[0]}`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("E2e!Pass1234");
    await page.getByRole("button", { name: "Continue to instructions" }).click();
    await page.waitForURL(new RegExp(`/exam/${SLUG}/instructions`));
    await passMobileNotice(page);
    await acceptInstructionsAndStart(page);

    // No fullscreen gate on phones — questions are directly usable.
    await expect(page.getByText("Return to full-screen to continue")).toHaveCount(0);
    await expect(page.getByText(`Question 1 of ${QUESTIONS}`)).toBeVisible();
    // Violation counter lives in the palette on narrow screens.
    await page.getByRole("button", { name: "Open question palette" }).click();
    await expect(page.getByRole("complementary").getByText("Violations: 0 / 3")).toBeVisible();
  });

  test("app switch / notification shade (blur) x3 auto-submits with answers saved", async ({
    page,
  }) => {
    const email = "e2e005@example.com";
    await resetStudent(email);
    await startExamThroughUI(page, email);

    await clickOption(page, "A"); // q1 correct letter is A
    await expectEventually(() => answerSaved(email, 1), "q1 auto-saved");

    await fireBlur(page); // user pulls down notifications / switches apps
    await expect(page.getByText("Violation 1 of 3")).toBeVisible({ timeout: 10000 });
    await fireBlur(page);
    await expect(page.getByText("Violation 2 of 3")).toBeVisible({ timeout: 10000 });
    await fireBlur(page);
    await expect(page.getByText("Your test has been submitted automatically")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 20000 });

    await expectEventually(async () => {
      const p = await participantRow(email);
      return p?.["status"] === "completed" && p?.["submit_reason"] === "violation";
    }, "auto-submitted by violation");
    expect(await answerSaved(email, 1)).toBe(true);
    const res = await resultRow(email);
    expect(Number(res!["total_correct"])).toBe(1); // saved answer was graded
  });

  test("screen lock / app switch (visibilitychange hidden) is recorded as a violation", async ({
    page,
  }) => {
    const email = "e2e006@example.com";
    await resetStudent(email);
    await startExamThroughUI(page, email);

    await fireHidden(page);
    await expect(page.getByText("Violation 1 of 3")).toBeVisible({ timeout: 10000 });
    await expectEventually(async () => {
      const p = await participantRow(email);
      return Number(p?.["tab_violation_count"]) === 1 && p?.["status"] === "in_progress";
    }, "one violation recorded, still in progress");
  });

  test("split-screen resize registers a violation on phones (B5 fixed)", async ({ page }) => {
    const email = "e2e004@example.com";
    await resetStudent(email);
    await startExamThroughUI(page, email);

    // Split-screen / floating window without focus loss: innerWidth collapses.
    await page.evaluate(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: Math.floor(window.innerWidth / 2),
      });
      window.dispatchEvent(new Event("resize"));
    });
    await expect(page.getByText(/^Violation \d+ of \d+$/)).toBeVisible({ timeout: 10000 });

    await expectEventually(
      async () => Number((await participantRow(email))?.["tab_violation_count"]) >= 1,
      "split-screen violation persisted",
    );
    expect((await participantRow(email))?.["status"]).toBe("in_progress");
  });

  test("orientation change registers a violation on phones (B5 fixed)", async ({ page }) => {
    const email = "e2e004@example.com";
    await resetStudent(email);
    await startExamThroughUI(page, email);

    await fireOrientationChange(page);
    await expect(page.getByText(/^Violation \d+ of \d+$/)).toBeVisible({ timeout: 10000 });

    await expectEventually(
      async () => Number((await participantRow(email))?.["tab_violation_count"]) >= 1,
      "orientation violation persisted",
    );
    expect((await participantRow(email))?.["status"]).toBe("in_progress");
  });
});
