import { test, expect } from "@playwright/test";

const BREAKPOINTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
];

const PAGES = ["/", "/about", "/services", "/solutions", "/industries", "/contact", "/quote"];

for (const bp of BREAKPOINTS) {
  test.describe(`Responsive @ ${bp.name} (${bp.width}px)`, () => {
    for (const path of PAGES) {
      test(`${path} has no horizontal overflow`, async ({ page }) => {
        await page.setViewportSize({ width: bp.width, height: bp.height });
        await page.goto(path);
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
      });
    }
  });
}

test.describe("Reduced motion", () => {
  test("hero still renders correctly with reduced motion", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /One control tower/ })).toBeVisible();
    await context.close();
  });
});
