import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("desktop header links reach every page", async ({ page }) => {
    await page.goto("/");
    const pages: [string, string][] = [
      ["About", "/about"],
      ["Services", "/services"],
      ["Solutions", "/solutions"],
      ["Industries", "/industries"],
      ["Contact", "/contact"],
    ];
    for (const [label, path] of pages) {
      await page.getByRole("link", { name: label, exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`${path}/?$`));
    }
  });

  test("primary CTA goes to the quote form", async ({ page }) => {
    await page.goto("/");
    await page.locator("header").getByRole("link", { name: "Get a Quote" }).click();
    await expect(page).toHaveURL(/\/quote\/?$/);
    await expect(page.getByRole("heading", { name: /Tell us what you need/i })).toBeVisible();
  });

  test("mobile menu opens and navigates", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator("header nav").getByRole("link", { name: "About" })).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator("header nav a:visible", { hasText: "Services" }).click();
    await expect(page).toHaveURL(/\/services\/?$/);
  });

  test("footer legal links resolve", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Privacy policy" }).click();
    await expect(page).toHaveURL(/\/privacy\/?$/);
  });
});
