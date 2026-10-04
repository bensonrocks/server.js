import type { Metadata } from "next";

// NEXT_PUBLIC_* vars are inlined at build time. The public canonical host
// is www — apex nimbustrade.co is not the URL we ask search engines to index.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.nimbustrade.co";
export const SITE_NAME = "NimbusTrade Solutions";

export const HOME_TITLE =
  "NimbusTrade — Logistics, fulfillment, and internationalization solutions for brands";

export const SITE_DESCRIPTION =
  "Brands looking to expand enquire with NimbusTrade for fulfillment solutions, logistics solutions, and internationalization solutions for brands. Retail enablement in Singapore and Malaysia, ecommerce fulfillment worldwide including the USA, and compliance such as FDA. We are merchants ourselves.";

// Self-run warehouses. Ecommerce fulfillment beyond these two markets is
// worldwide; do not turn a partner list into a country count.
export const SELF_RUN_MARKETS = ["Singapore", "Malaysia"];

export function formatMarketList(markets: string[]): string {
  if (markets.length <= 1) return markets.join("");
  if (markets.length === 2) return markets.join(" and ");
  return `${markets.slice(0, -1).join(", ")}, and ${markets[markets.length - 1]}`;
}

export function canonicalUrl(path: string): string {
  if (path === "/") return `${SITE_URL}/`;
  return `${SITE_URL}${path}`;
}

/** Unique title, description, canonical, and social tags for a marketing page. */
export function marketingMeta(opts: {
  title: string;
  description: string;
  path: string;
  absoluteTitle?: boolean;
}): Metadata {
  const canonical = canonicalUrl(opts.path);
  return {
    title: opts.absoluteTitle ? { absolute: opts.title } : opts.title,
    description: opts.description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "en_SG",
      url: canonical,
      siteName: SITE_NAME,
      title: opts.title,
      description: opts.description,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: SITE_NAME,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
      images: ["/og-image.png"],
    },
  };
}
