/**
 * QA-500 · Desktop proctoring — full-screen lock, violation detection and the
 * 3-strikes auto-submit rule (desktop browsers only).
 *
 * Violations are triggered deterministically (synthetic blur/visibilitychange
 * events + the real Fullscreen API) so the tests are headless-safe and do not
 * depend on a human switching windows.
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
  participantRow,
  resultRow,
  expectEventually,
  fireBlur,
  fireHidden,
  fireContextMenu,
  exitFullscreenNow,
} from "./helpers";

function desktopOnly(testInfo: { project: { name: string } }) {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop-only proctoring scenario");
}

async function startOrSkip(page: Parameters<typeof startExamThroughUI>[0], email: string) {
  await startExamThroughUI(page, email).catch((e) => {
    if (e instanceof FullscreenUnavailable) test.skip(true, e.message);
    throw e;
  });
}

test.describe("desktop proctoring", () => {
  test("3 violations auto-submit the exam with answers saved and redirect to the submitted page", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo);
    const email = "e2e001@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    // Real answer before any violation — must survive the forced submit (q1's
    // correct letter is A by the seeded rotation).
    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "q1 auto-saved before violations");

    // Violation 1: hidden tab (screen lock / app switch / tab switch)
    await fireHidden(page);
    await expect(page.getByText("Violation 1 of 3")).toBeVisible({ timeout: 10000 });

    // Violation 2: window lost focus (Alt+Tab / another app)
    await fireBlur(page);
    await expect(page.getByText("Violation 2 of 3")).toBeVisible({ timeout: 10000 });

    // Violation 3: auto-submit
    await fireBlur(page);
    await expect(page.getByText("Your test has been submitted automatically")).toBeVisible({
      timeout: 10000,
    });
    await page.waitForURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 20000 });
    await expect(page.getByRole("heading", { name: "Your test has been submitted" })).toBeVisible();

    // Server state: completed by violation, answers + grading intact.
    await expectEventually(async () => {
      const p = await participantRow(email);
      return p?.["status"] === "completed" && p?.["submit_reason"] === "violation";
    }, "participant completed with submit_reason=violation");
    const p = await participantRow(email);
    expect(Number(p?.["tab_violation_count"])).toBeGreaterThanOrEqual(3);
    expect(await answerSaved(email, 1)).toBe(true); // answer not lost
    const res = await resultRow(email);
    expect(res).not.toBeNull();
    expect(
      Number(res!["total_correct"]) + Number(res!["total_wrong"]) + Number(res!["total_unattempted"]),
    ).toBe(QUESTIONS);
    expect(Number(res!["total_correct"])).toBe(1); // q1 answered A = correct
  });

  test("exiting full screen (Esc / API exit) registers exactly one violation and can be recovered", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo);
    const email = "e2e002@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    // Capability check: the exam must actually be in fullscreen here.
    const inFs = await page.evaluate(() => Boolean(document.fullscreenElement));
    test.skip(!inFs, "Fullscreen API unavailable in this browser/runtime");

    await exitFullscreenNow(page);
    await expect(page.getByText("Violation 1 of 3")).toBeVisible({ timeout: 10000 });

    // Recovery path: return to full screen → overlay clears, exam continues.
    await page.getByRole("button", { name: "Return to Full-Screen" }).click();
    await expect(page.getByText("Violation 1 of 3")).toBeHidden({ timeout: 10000 });
    await expect(page.getByText(`Question 1 of ${QUESTIONS}`)).toBeVisible();

    const p = await participantRow(email);
    expect(Number(p?.["tab_violation_count"])).toBe(1);
    expect(p?.["status"]).toBe("in_progress"); // ONE violation must not submit

    // Leaving fullscreen again must count as a second, distinct violation.
    await exitFullscreenNow(page);
    await expect(page.getByText("Violation 2 of 3")).toBeVisible({ timeout: 10000 });
  });

  test("window resize / half-screen snap registers a violation (B5 fixed)", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo);
    const email = "e2e003@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    // Entering fullscreen itself resizes the viewport; the app ignores resizes
    // for 2s around a fullscreen transition. Wait that out first.
    await page.waitForTimeout(2600);

    // A real split-screen/half-snap changes innerWidth by >22%.
    await page.evaluate(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: Math.floor(window.innerWidth / 2),
      });
      window.dispatchEvent(new Event("resize"));
    });

    // The overlay is optimistic; the counter is persisted by the RPC — poll.
    await expect(page.getByText(/^Violation \d+ of \d+$/)).toBeVisible({ timeout: 15000 });
    await expectEventually(
      async () => Number((await participantRow(email))?.["tab_violation_count"]) >= 1,
      "resize violation persisted",
    );
    expect((await participantRow(email))?.["status"]).toBe("in_progress"); // one strike must not end the exam
  });

  test("narrowing the window mid-exam never replaces the exam with the phone notice (B9 fixed)", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo);
    const email = "e2e002@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    // Wait out the fullscreen transition guard, then snap the window narrow
    // (below the 768px phone breakpoint) — the old code unmounted the exam and
    // showed "You're on a phone", making a running attempt unreachable.
    await page.waitForTimeout(2600);
    await page.evaluate(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
      window.dispatchEvent(new Event("resize"));
    });

    await expect(page.getByRole("heading", { name: "You're on a phone" })).toHaveCount(0);
    await expect(page.getByText(`Question 1 of ${QUESTIONS}`)).toBeVisible();
    await expect(page.getByText(/^Violation \d+ of \d+$/)).toBeVisible({ timeout: 15000 });

    await expectEventually(
      async () => Number((await participantRow(email))?.["tab_violation_count"]) >= 1,
      "resize violation persisted (attempt still alive)",
    );
    expect((await participantRow(email))?.["status"]).toBe("in_progress"); // the attempt survived the resize
  });

  test("devtools / right-click / copy / print shortcuts are intercepted; the 3rd strike submits (B6 fixed)", async ({
    page,
  }, testInfo) => {
    desktopOnly(testInfo);
    const email = "e2e003@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    // 1) Right-click is blocked and counted.
    await fireContextMenu(page);
    await expect(page.getByText("Violation 1 of 3")).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Return to Full-Screen" }).click();
    await expect(page.getByText("Violation 1 of 3")).toBeHidden({ timeout: 10000 });

    // 2) Copying exam content (Ctrl+C / context-menu Copy) is counted.
    await page.evaluate(() => document.dispatchEvent(new Event("copy", { cancelable: true })));
    await expect(page.getByText("Violation 2 of 3")).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Return to Full-Screen" }).click();
    await expect(page.getByText("Violation 2 of 3")).toBeHidden({ timeout: 10000 });

    // 3) DevTools shortcut (F12) is the third strike → automatic submission.
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true })),
    );
    await expect(page.getByText(/submitted automatically|Violation limit reached/i).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page).toHaveURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 20000 });

    const p = await participantRow(email);
    expect(Number(p?.["tab_violation_count"])).toBeGreaterThanOrEqual(3);
    expect(p?.["status"]).toBe("completed");
    expect(p?.["submit_reason"]).toBe("violation");
  });
});
