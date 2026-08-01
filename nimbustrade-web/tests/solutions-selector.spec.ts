import { test, expect } from "@playwright/test";

test.describe("Solutions selector", () => {
  test("switching tabs updates content without navigation", async ({ page }) => {
    await page.goto("/solutions");
    await expect(page.getByRole("heading", { name: "Warehousing", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Freight" }).click();
    await expect(page.getByRole("heading", { name: "Freight", exact: true })).toBeVisible();
    await expect(page.getByText("FCL / LCL ocean")).toBeVisible();
    await expect(page).toHaveURL(/\/solutions\/?$/);

    await page.getByRole("tab", { name: "Customs & compliance" }).click();
    await expect(page.getByRole("heading", { name: "Customs & compliance" })).toBeVisible();
  });
});
