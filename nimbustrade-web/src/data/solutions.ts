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
      "Direct-to-consumer and B2B fulfilment connected to your storefronts, with same-day dispatch cut-offs.",
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
    question: "I need goods delivered across the region.",
    description:
      "Regional and last-mile delivery coordinated across a panel of local carrier partners under one SLA.",
    included: ["Route planning", "Proof of delivery", "Regional carrier panel", "Delivery reporting"],
  },
  {
    slug: "e-commerce",
    name: "E-commerce operations",
    question: "I sell on marketplaces and my own storefront.",
    description:
      "Order and inventory intake across your marketplaces and storefront, supported via file upload so nothing needs re-keying — API sync where a connector is already in place.",
    included: ["Order intake", "Inventory allocation", "Channel reporting", "Peak-sale scaling"],
  },
  {
    slug: "cross-border",
    name: "Cross-border expansion",
    question: "I want to sell into a new country.",
    description:
      "A staged way into a new market's logistics — local handoff partners without hiring a local team first.",
    included: ["Multi-country lanes", "Local handoffs", "Landed-cost estimate", "Market entry review"],
  },
  {
    slug: "customs",
    name: "Customs & compliance",
    question: "I need help with border documentation.",
    description:
      "Customs coordination handled alongside the shipment itself, not as a separate vendor to manage.",
    included: ["HS classification support", "Permit coordination", "Duty documentation", "Audit trail"],
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
