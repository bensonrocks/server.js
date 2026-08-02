// NEXT_PUBLIC_* vars are inlined at build time — set this in the build
// environment if the canonical domain ever changes. Defaults to the
// production apex domain, not the Railway hosting subdomain.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://nimbustrade.co";
export const SITE_NAME = "NimbusTrade Solutions";

export const SITE_DESCRIPTION =
  "NimbusTrade Solutions is a Singapore-based 4PL control tower coordinating warehousing, pick-and-pack, freight, and cross-border delivery for ecommerce brands across Southeast Asia, run from one operating desk.";

export const SITE_KEYWORDS = [
  "ecommerce fulfillment Southeast Asia",
  "3PL Singapore",
  "4PL Singapore",
  "Southeast Asia logistics partner",
  "cross-border fulfillment SEA",
  "warehouse Singapore Malaysia",
  "ecommerce logistics Singapore",
  "B2B B2C fulfillment",
];
