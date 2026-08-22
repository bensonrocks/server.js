import { test, expect } from "@playwright/test";

test.describe("Intro splash", () => {
  test("shows once, is skippable, and never re-shows this session", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();

    await page.getByRole("button", { name: "Skip" }).click();
    await expect(page.getByRole("heading", { name: /The operating layer/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /The operating layer/ })).toBeVisible();
  });

  test("auto-dismisses on its own after a few seconds", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0, { timeout: 4000 });
  });

  test("is skipped entirely under prefers-reduced-motion", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /The operating layer/ })).toBeVisible();
    await context.close();
  });
});
