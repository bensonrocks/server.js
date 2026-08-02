import { test, expect } from "@playwright/test";

test.describe("Platform mock-up", () => {
  test("tabs and filter genuinely filter the visible rows", async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("nt-intro-seen", "1"));
    await page.goto("/");
    const platform = page.locator("section", { hasText: "The same screen we work from" });
    await platform.scrollIntoViewIfNeeded();

    await expect(platform.getByText("ORD-3021")).toBeVisible();

    await platform.getByRole("tab", { name: "Inventory" }).click();
    await expect(platform.getByText("SKU-1042")).toBeVisible();
    await expect(platform.getByText("ORD-3021")).toHaveCount(0);

    const filterInput = platform.getByPlaceholder("Filter this list…");
    await filterInput.fill("serum");
    await expect(platform.getByText("SKU-2210")).toBeVisible();
    await expect(platform.getByText("SKU-1042")).toHaveCount(0);

    await filterInput.fill("nonexistent-query-xyz");
    await expect(platform.getByText(/No rows match/)).toBeVisible();
  });
});
