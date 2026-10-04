export interface Solution {
  slug: string;
  name: string;
  question: string;
  description: string;
  included: string[];
}

export const SOLUTIONS: Solution[] = [
  {
    slug: "warehousing",
    name: "Warehousing",
    question: "I need somewhere reliable to hold stock.",
    description:
      "Storage that flexes with your volume — from a single pallet to a dedicated bay — without a fixed-term lease.",
    included: ["Bin & pallet storage", "Cycle counts", "Inbound QC"],
  },
  {
    slug: "fulfilment",
    name: "Fulfilment",
    question: "I need orders picked, packed, and shipped fast.",
    description:
      "Direct-to-consumer and B2B fulfilment from one inventory pool, connected to your storefronts, with same-day dispatch before the cut-off.",
    included: ["Pick & pack", "Kitting & bundling", "Branded packaging", "Returns handling"],
  },
  {
    slug: "freight",
    name: "Freight",
    question: "I need cargo moved between countries.",
    description:
      "Ocean and air freight booked through our carrier panel with milestone tracking from origin to arrival.",
    included: ["FCL / LCL ocean", "Airfreight", "Consolidation", "Milestone visibility"],
  },
  {
    slug: "distribution",
    name: "Distribution",
    question: "I need goods delivered, including outside the region.",
    description:
      "Last-mile and onward delivery, worldwide including the USA, coordinated with the carriers appointed for each lane.",
    included: ["Route planning", "Proof of delivery", "Regional carrier panel", "Delivery reporting"],
  },
  {
    slug: "e-commerce",
    name: "E-commerce operations",
    question: "I sell on marketplaces and my own storefront.",
    description:
      "Retail and ecommerce enablement for brands selling in Singapore and Malaysia — order and inventory intake by file upload, or API sync where a connector is already in place.",
    included: ["Order intake", "Inventory allocation", "Channel reporting", "Peak-sale scaling"],
  },
  {
    slug: "cross-border",
    name: "Cross-border expansion",
    question: "I want to sell into a new country.",
    description:
      "A staged way into a new lane, including the USA. Appointed partners can hold stock closer to the buyer, with Merchant or Importer of Record support where the destination asks for an entity of record.",
    included: [
      "Multi-country lanes",
      "Local handoffs",
      "Landed-cost estimate",
      "Merchant/Importer of Record",
    ],
  },
  {
    slug: "customs",
    name: "Customs & compliance",
    question: "I need help with border documentation.",
    description:
      "Customs and regulatory compliance handled with the shipment, including FDA and similar work, and Merchant or Importer of Record where the destination asks for an entity of record.",
    included: [
      "FDA and similar regulatory compliance",
      "HS classification support",
      "Permit coordination",
      "Duty documentation",
      "Merchant/Importer of Record",
    ],
  },
  {
    slug: "tech-integration",
    name: "Technology integration",
    question: "I want my systems talking to my 3PL.",
    description:
      "Connect to IdealOne, our in-house platform, via API or file feed — or run everything from the dashboard with no integration at all. Built for both B2B and B2C order flows.",
    included: ["Order & inventory feeds", "Webhook updates", "No-integration dashboard access", "Sandbox access"],
  },
];
