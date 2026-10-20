/**
 * QA-500 · MAX_VIOLATIONS is configuration, not a constant (bug B4).
 *
 * The test reads the limit the SERVER reports (getExamState.maxViolations —
 * derived from the MAX_VIOLATIONS env var), asserts the UI renders that same
 * number, then drives exactly that many violations and checks the attempt is
 * force-submitted on the last one.
 *
 * Default run:            MAX_VIOLATIONS=3 (see .env.test)
 * Configurability proof:  start staging with MAX_VIOLATIONS=2 and re-run this
 *                         spec (`npm run qa500:config-check`); the result is
 *                         written to tests/.artifacts/qa500/max-violations-check.json
 *                         and picked up by the report (TC-24).
 *
 * Runs once (desktop Chromium) — it is a configuration check, not a browser
 * compatibility matrix.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  SLUG,
  FullscreenUnavailable,
  resetStudent,
  startExamThroughUI,
  participantRow,
  expectEventually,
  fireBlur,
  apiCall,
} from "./helpers";

const ART_DIR = path.join(process.cwd(), "tests", ".artifacts", "qa500");

test.describe("configurable MAX_VIOLATIONS", () => {
  test.skip(
    ({ browserName, isMobile }) => isMobile || browserName !== "chromium",
    "configuration check runs once in desktop Chromium",
  );

  test("auto-submits on exactly the configured limit (env-driven, not hardcoded)", async ({ page }) => {
    const email = "e2e001@example.com";
    await resetStudent(email);
    await startExamThroughUI(page, email).catch((e) => {
      if (e instanceof FullscreenUnavailable) test.skip(true, e.message);
      throw e;
    });

    const token = String((await participantRow(email))?.["session_token"]);
    const state = await apiCall("getExamState", { slug: SLUG, token });
    const limit = Number(state.result?.maxViolations);
    expect(Number.isFinite(limit) && limit >= 1).toBe(true);

    // The UI must derive its counter from the server value, not a literal 3.
    await expect(page.getByText(`Violations: 0 / ${limit}`).first()).toBeVisible();

    for (let i = 1; i <= limit; i += 1) {
      await fireBlur(page);
      if (i < limit) {
        await expect(page.getByText(`Violation ${i} of ${limit}`)).toBeVisible({ timeout: 10000 });
      } else {
        await expect(page.getByText("Your test has been submitted automatically")).toBeVisible({
          timeout: 15000,
        });
      }
    }

    await page.waitForURL(new RegExp(`/exam/${SLUG}/submitted`), { timeout: 20000 });
    await expectEventually(async () => {
      const p = await participantRow(email);
      return p?.["status"] === "completed" && p?.["submit_reason"] === "violation";
    }, "completed by violation at the configured limit");

    const row = await participantRow(email);
    const observedCount = Number(row?.["tab_violation_count"]);
    expect(observedCount).toBe(limit);

    fs.mkdirSync(ART_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ART_DIR, "max-violations-check.json"),
      JSON.stringify(
        {
          limit,
          observedCount,
          submitReason: row?.["submit_reason"] ?? null,
          pass: observedCount === limit && row?.["submit_reason"] === "violation",
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  });
});
