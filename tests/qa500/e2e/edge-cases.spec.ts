/**
 * QA-500 · Edge cases & failure tests (asserting the fixed behaviour):
 *   1. page refresh mid-exam → answers + timer restore, NO violation (B8)
 *   2. short network drop → queued retries recover the answer
 *   3. 30s network drop → the persistent outbox still saves on reconnect (B2)
 *   4. submit while offline → queued and delivered on reconnect (B1)
 *   5. slow 3G throttling (CDP, Chromium) → answers still save
 *   6. same user on two devices → the second login ends the first session (B3)
 * (Server-restart mid-exam is scenario D in k6 — see tests/qa500/README.md.)
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
  answerValue,
  responseCount,
  participantRow,
  expectEventually,
  clockSeconds,
  gotoLastQuestion,
  gotoQuestion,
  submitViaUI,
  apiCall,
} from "./helpers";

async function startOrSkip(page: Parameters<typeof startExamThroughUI>[0], email: string) {
  await startExamThroughUI(page, email).catch((e) => {
    if (e instanceof FullscreenUnavailable) test.skip(true, e.message);
    throw e;
  });
}

/** After a reload the desktop fullscreen gate may be back — dismiss it once. */
async function dismissGateIfAny(page: Parameters<typeof startExamThroughUI>[0]) {
  const gate = page.getByText("Return to full-screen to continue");
  if (await gate.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.getByRole("button", { name: "Return to Full-Screen" }).click();
    await expect(gate).toBeHidden({ timeout: 10000 });
  }
}

test.describe("edge cases", () => {
  test("page refresh mid-exam restores answers and the server timer without a violation (B8 fixed)", async ({
    page,
  }) => {
    const email = "e2e010@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "q1 saved before refresh");
    const rowBefore = await participantRow(email);
    const startedBefore = rowBefore?.["exam_started_at"];
    const clockBefore = await clockSeconds(page);

    await page.reload();
    await dismissGateIfAny(page);
    await expect(page.getByText(`Question 1 of ${QUESTIONS}`)).toBeVisible({ timeout: 20000 });

    // Saved answer is selected again (restored from the DB, not memory).
    const optA = page.locator("button.min-h-16").filter({ hasText: /^A/ }).first();
    await expect(optA).toHaveClass(/bg-pale-green/);

    // Timer continuity: same server start, clock only moved forward.
    const rowAfter = await participantRow(email);
    expect(rowAfter?.["exam_started_at"]).toBe(startedBefore);
    const clockAfter = await clockSeconds(page);
    expect(clockAfter).toBeLessThanOrEqual(clockBefore);
    expect(clockAfter).toBeGreaterThan(clockBefore - 60);
    expect(clockAfter).toBeGreaterThan(0);

    // A refresh is a legitimate recovery path: it must never end the attempt
    // and must not be counted as a proctoring violation (beforeunload/pagehide
    // mark the unload, so blur/visibilitychange noise is ignored).
    expect(rowAfter?.["status"]).toBe("in_progress");
    expect(Number(rowAfter?.["tab_violation_count"])).toBe(0);
    expect(await responseCount(email)).toBe(1);

    // Three refreshes in a row must still leave the attempt untouched.
    await page.reload();
    await dismissGateIfAny(page);
    await page.reload();
    await dismissGateIfAny(page);
    await expect(page.getByText(`Question 1 of ${QUESTIONS}`)).toBeVisible({ timeout: 20000 });
    const rowAfter3 = await participantRow(email);
    expect(rowAfter3?.["status"]).toBe("in_progress");
    expect(Number(rowAfter3?.["tab_violation_count"])).toBe(0);
  });

  test("short network drop (<13s): queued retries save the answer after reconnect", async ({
    page,
    context,
  }) => {
    const email = "e2e011@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);

    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "q1 saved while online");
    const clockBefore = await clockSeconds(page);

    // Move to question 2 first — clicking an option only answers the question
    // currently on screen (the app has no auto-advance).
    await gotoQuestion(page, 2);
    await context.setOffline(true);
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 }); // offline banner
    await clickOption(page, "B"); // q2 — queued save while offline

    await page.waitForTimeout(7000);
    await context.setOffline(false);
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 10000 });

    // The in-page retry ladder (0.6/1.4/3/6.2/12.6s) finishes after reconnect.
    await expectEventually(() => answerSaved(email, 2), "q2 saved by retry after reconnect", 25000);
    expect(await responseCount(email)).toBe(2);

    // Timer kept running on the server during the outage.
    const clockAfter = await clockSeconds(page);
    expect(clockAfter).toBeLessThan(clockBefore); // strictly less: time passed
  });

  test("30s network drop: the persistent outbox still saves the answer after reconnect (B2 fixed)", async ({
    page,
    context,
  }) => {
    const email = "e2e011@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);
    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "q1 saved while online");

    await gotoQuestion(page, 2);
    await context.setOffline(true);
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await clickOption(page, "B");

    // The answer is held in the outbox and surfaced in the header (no give-up).
    await expect(page.getByText(/\d+ unsaved/)).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(32000); // now >30s offline — longer than 5 attempts
    expect(await answerSaved(email, 2)).toBe(false); // nothing reached the server yet
    expect(await responseCount(email)).toBe(1);

    // Reconnect: the outbox flushes automatically, without re-clicking.
    await context.setOffline(false);
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 10000 });
    await expectEventually(() => answerSaved(email, 2), "q2 saved by the outbox after reconnect", 30000);
    expect(await responseCount(email)).toBe(2);
    await expect(page.getByText(/\d+ unsaved/)).toBeHidden({ timeout: 15000 });
  });

  test("submit while offline: the submit is queued and lands automatically on reconnect (B1 fixed)", async ({
    page,
    context,
  }) => {
    const email = "e2e012@example.com";
    await resetStudent(email);
    await startOrSkip(page, email);
    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "q1 saved while online");

    await context.setOffline(true);
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await gotoLastQuestion(page);
    await submitViaUI(page).catch(() => {});

    // No false success page: the student sees a "waiting for the server" gate
    // and the attempt is still open server-side.
    await expect(page.getByText("Waiting for the server…")).toBeVisible({ timeout: 15000 });
    await expect(page).not.toHaveURL(new RegExp(`/exam/${SLUG}/submitted`));
    const stillOpen = await participantRow(email);
    expect(stillOpen?.["status"]).toBe("in_progress");
    expect(stillOpen?.["submit_reason"]).toBeNull();

    // Reconnect: the queued submit is flushed automatically → real success.
    await context.setOffline(false);
    await expect(page).toHaveURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 30000 });
    await expect(page.getByRole("heading", { name: "Your test has been submitted" })).toBeVisible({
      timeout: 15000,
    });

    await expectEventually(async () => {
      const row = await participantRow(email);
      return row?.["status"] === "completed" && row?.["submit_reason"] === "manual";
    }, "server received the queued manual submission");
    expect(await answerSaved(email, 1)).toBe(true); // saved answers survived
  });

  // Firefox tears down this test's context forever if it is skipped in-body
  // (Juggler bug), so gate the whole block before fixtures exist.
  test.describe("slow 3G (Chromium-only CDP)", () => {
    test.skip(({ browserName }) => browserName !== "chromium", "CDP network emulation is Chromium-only");

    test("slow 3G throttling: answers still reach the server", async ({ page }) => {
      const email = "e2e010@example.com";
      await resetStudent(email);
      await startOrSkip(page, email);

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 400,
        downloadThroughput: (700 * 1024) / 8,
        uploadThroughput: (400 * 1024) / 8,
      });
      try {
        await clickOption(page, "B");
        await expectEventually(() => answerSaved(email, 1), "answer saved over 3G", 30000);
      } finally {
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      }
    });
  });

  test("same user on two devices: the second login rotates the token and ends the first session (B3 fixed)", async ({
    page,
    browser,
  }) => {
    const email = "e2e012@example.com";
    await resetStudent(email);
    await startOrSkip(page, email); // device 1 — mid-exam
    await clickOption(page, "A");
    await expectEventually(() => answerSaved(email, 1), "device 1 saved q1");
    const tokenBefore = String((await participantRow(email))?.["session_token"]);

    // Device 2: brand-new browser context, same credentials.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    try {
      await page2.goto(`/exam/${SLUG}`);
      await page2.locator("#name").fill(`QA500 ${email.split("@")[0]}`);
      await page2.locator("#email").fill(email);
      await page2.locator("#password").fill("E2e!Pass1234");
      await page2.getByRole("button", { name: "Continue to instructions" }).click();

      // The second login is accepted (device 2 takes over)…
      await page2.waitForURL(new RegExp(`/exam/${SLUG}/instructions`), { timeout: 20000 });
      // …but it rotates the session token, so device 1 is no longer authorised.
      const tokenAfter = String((await participantRow(email))?.["session_token"]);
      expect(tokenAfter).not.toBe(tokenBefore);

      // Device 1's stale token is rejected: the write must not land…
      const stale = await apiCall("saveAnswer", {
        slug: SLUG,
        token: tokenBefore,
        questionId: 1,
        option: "B",
      });
      expect(stale.result?.invalidSession).toBe(true);
      expect(await answerValue(email, 1)).toBe("A"); // …q1 still has device 1's original answer

      // …and the stale token can no longer read the exam either.
      const staleState = await apiCall("getExamState", { slug: SLUG, token: tokenBefore });
      expect(String(staleState.error?.message ?? "")).toContain("NOT_AUTHENTICATED");

      // Device 1's UI ends the session: after a refresh it cannot resume and is
      // sent back to the login screen (its stored token is dead).
      await page.reload();
      await page.waitForURL(new RegExp(`/exam/${SLUG}/?$`), { timeout: 20000 });
      await expect(page.getByRole("heading", { name: "Student login" })).toBeVisible({ timeout: 10000 });

      expect(await responseCount(email)).toBe(1);
      expect((await participantRow(email))?.["status"]).toBe("in_progress");
    } finally {
      await ctx2.close();
    }
  });
});
