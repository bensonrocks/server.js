import { test, expect } from "@playwright/test";

const PAGES = ["/", "/about", "/services", "/solutions", "/industries", "/contact", "/quote"];

test.describe("Public copy", () => {
  for (const path of PAGES) {
    test(`${path} does not call the company a desk`, async ({ page }) => {
      await page.goto(path);
      const visible = await page.locator("body").innerText();
      const description = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
      const title = await page.title();
      const copy = `${title}\n${description}\n${visible}`;
      expect(copy).not.toMatch(/\bdesks?\b/i);
      expect(copy).not.toMatch(/help desk|service desk|operating desk/i);
    });
  }

  test("homepage keeps the merchant line and the explainer", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "We run fulfillment, retail enablement, and logistics." }),
    ).toBeVisible();
    await expect(page.getByText("We are merchants ourselves, so we know this work from the inside.")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Fulfillment, retail enablement, and logistics — run by merchants." }),
    ).toBeVisible();
    const explainer = page.locator("#explainer");
    await expect(explainer.getByRole("link", { name: "info@nimbustrade.co" })).toBeVisible();
    await expect(explainer).toContainText("Singapore and Malaysia");
    await expect(explainer).toContainText("including the USA");
    await expect(explainer).toContainText("one inventory pool");
    await expect(explainer).toContainText("FDA");
    await expect(explainer).toContainText("appointed partners");
  });
});
