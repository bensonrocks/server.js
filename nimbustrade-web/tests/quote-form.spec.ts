import { test, expect } from "@playwright/test";

test.describe("Multi-step quotation form", () => {
  test("blocks advancing without a required field, then completes end to end", async ({ page }) => {
    await page.goto("/quote");

    // Step 1: Services — Next without selecting should show a validation error.
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Pick at least one service")).toBeVisible();

    await page.getByRole("button", { name: "Warehousing" }).click();
    await page.getByRole("button", { name: "Fulfilment" }).click();
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();

    // Step 2: shipment details
    await page.locator("textarea").fill("About 150 SKUs, mostly small parcels, holiday spike.");
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();

    // Step 3: origin / destination
    await page.locator("#originCountry").fill("Vietnam");
    await page.locator("#destinationCountry").fill("Singapore, Malaysia");
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();

    // Step 4: volume
    await page.locator("#monthlyVolume").click();
    await page.getByRole("option", { name: "100–500 orders / month" }).click();
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();

    // Step 5: contact
    await page.locator("#fullName").fill("Jamie Tan");
    await page.locator("#email").fill("jamie@example.com");
    await page.locator("#company").fill("Example Pte Ltd");
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();

    // Step 6: review — confirm the summary reflects earlier steps
    await expect(page.getByText("Warehousing, Fulfilment", { exact: true })).toBeVisible();
    await expect(page.getByText("Vietnam")).toBeVisible();

    // Back should return to the contact step without losing data
    await page.locator("form").getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.locator("#fullName")).toHaveValue("Jamie Tan");
    await page.locator("form").getByRole("button", { name: "Next", exact: true }).click();

    // The success state replaces the form (and this button) almost immediately,
    // which can race Playwright's own post-click stability re-check — so a
    // short timeout here is expected to occasionally "fail" after the real
    // click already landed; the assertion below is what actually matters.
    await page
      .locator('button[type="submit"]')
      .click({ timeout: 3000 })
      .catch(() => {});
    await expect(page.getByText("Quote request received")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/jamie@example\.com/)).toBeVisible();
  });
});
