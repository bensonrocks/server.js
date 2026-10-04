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
    await expect(
      page.getByText("We are merchants ourselves, so we know this work from the inside.").first(),
    ).toBeVisible();
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
    await expect(page.getByText("You still deal with the merchants who run the work.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("either way");
    await expect(page.locator("footer")).not.toContainText(/desk/i);
  });

  test("search themes are in the title, description, a heading, and the body", async ({ page }) => {
    await page.goto("/");
    const title = await page.title();
    const description = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    const visible = await page.locator("body").innerText();
    expect(title).toContain("internationalization solutions for brands");
    expect(description).toContain("fulfillment solutions");
    expect(description).toContain("logistics solutions");
    expect(description).toContain("internationalization solutions for brands");
    await expect(
      page.getByRole("heading", { name: "Fulfillment solutions, from the pick face to the freight lane." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Internationalization solutions for brands." }),
    ).toBeVisible();
    await expect(page.locator("body")).toContainText("logistics solutions");
    await expect(page.locator("body")).toContainText("fulfillment solutions");
    const copy = `${title}\n${description}\n${visible}`;
    expect(copy).not.toMatch(/search volume|monthly searches|\d[\d,]*\s+searches/i);
    expect(copy).not.toMatch(/\b\d{6}\b/);
    expect(copy).not.toMatch(/unit\s*#|street|postal code|Penjuru/i);
  });

  test("services and solutions pages each own a theme", async ({ page }) => {
    await page.goto("/services");
    await expect(page).toHaveTitle(/Fulfillment solutions and logistics solutions/);
    await expect(
      page.getByRole("heading", { name: "Fulfillment solutions and logistics solutions." }),
    ).toBeVisible();
    const servicesDescription =
      (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    expect(servicesDescription).toContain("fulfillment solutions");
    expect(servicesDescription).toContain("logistics solutions");

    await page.goto("/solutions");
    await expect(page).toHaveTitle(/Internationalization solutions for brands/);
    await expect(
      page.getByRole("heading", { name: "Internationalization solutions for brands." }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "info@nimbustrade.co" }).first()).toBeVisible();
  });
});
