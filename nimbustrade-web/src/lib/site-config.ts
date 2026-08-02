// NEXT_PUBLIC_* vars are inlined at build time — set this in the build
// environment if the canonical domain ever changes. Defaults to the
// production apex domain, not the Railway hosting subdomain.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://nimbustrade.co";
export const SITE_NAME = "NimbusTrade Solutions";

export const SITE_DESCRIPTION =
  "NimbusTrade Solutions is a Singapore-based 4PL control tower — self-run warehousing in Singapore and Malaysia, coordinated with appointed fulfillment partners across the Philippines, Indonesia, Thailand, and onward into Mexico, the US, Canada, Australia, New Zealand, the UK, and the UAE — run from one operating desk.";

export const SITE_KEYWORDS = [
  "ecommerce fulfillment Southeast Asia",
  "3PL Singapore",
  "4PL Singapore",
  "Southeast Asia logistics partner",
  "cross-border fulfillment SEA",
  "warehouse Singapore Malaysia",
  "ecommerce logistics Singapore",
  "B2B B2C fulfillment",
  "global fulfillment partner network",
];

// Self-run: NimbusTrade operates these warehouses directly.
export const SELF_RUN_MARKETS = ["Singapore", "Malaysia"];

// Appointed-partner markets: fulfillment handled by vetted local partners held
// to NimbusTrade's standards, not run by NimbusTrade directly.
export const PARTNER_MARKETS = [
  "Philippines",
  "Indonesia",
  "Thailand",
  "Mexico",
  "United States",
  "Canada",
  "Australia",
  "New Zealand",
  "United Kingdom",
  "United Arab Emirates",
];

// "A, B, and C" — Oxford comma, no dependency needed for a list this short.
export function formatMarketList(markets: string[]): string {
  if (markets.length <= 1) return markets.join("");
  if (markets.length === 2) return markets.join(" and ");
  return `${markets.slice(0, -1).join(", ")}, and ${markets[markets.length - 1]}`;
}
