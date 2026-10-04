import type { LucideIcon } from "lucide-react";
import {
  Warehouse,
  PackageCheck,
  Ship,
  Truck,
  ShoppingCart,
  Globe2,
  FileCheck2,
  Cpu,
} from "lucide-react";

export interface Service {
  slug: string;
  name: string;
  icon: LucideIcon;
  summary: string;
  benefit: string;
  points: string[];
}

export const SERVICES: Service[] = [
  {
    slug: "warehousing",
    name: "Warehousing",
    icon: Warehouse,
    summary:
      "Self-run storage in Singapore and Malaysia for retail and ecommerce, with appointed partner warehouses further afield. The same desk holds the standard.",
    benefit: "Pay for the space you use, not a fixed lease.",
    points: ["Bin and pallet storage", "Cycle counting", "Temperature-aware zoning"],
  },
  {
    slug: "fulfilment",
    name: "Fulfilment",
    icon: PackageCheck,
    summary:
      "Pick, pack, and dispatch for D2C and B2B orders, connected directly to your storefront and marketplace queues.",
    benefit: "Same-day dispatch on orders received before cut-off.",
    points: ["Carton and kitting options", "Branded packaging inserts", "Returns processing"],
  },
  {
    slug: "freight-forwarding",
    name: "Freight forwarding",
    icon: Ship,
    summary:
      "Ocean and air freight booked and tracked through our carrier panel, with milestone visibility from origin to port.",
    benefit: "One reference number, not five carrier logins.",
    points: ["FCL / LCL ocean freight", "Airfreight consolidation", "Milestone tracking"],
  },
  {
    slug: "distribution",
    name: "Distribution",
    icon: Truck,
    summary:
      "Last-mile and onward distribution, coordinated worldwide — including the USA — with the carriers appointed for each lane.",
    benefit: "One desk for the delivery, wherever the lane runs.",
    points: ["Route planning", "Proof of delivery capture", "Regional carrier panel"],
  },
  {
    slug: "e-commerce-operations",
    name: "E-commerce operations",
    icon: ShoppingCart,
    summary:
      "Retail and ecommerce enablement for brands selling in Singapore and Malaysia: marketplace and storefront orders, by file upload or an existing connector.",
    benefit: "Orders flow to the warehouse floor without manual re-keying.",
    points: ["Order intake", "Inventory allocation", "Channel-level reporting"],
  },
  {
    slug: "cross-border",
    name: "Cross-border logistics",
    icon: Globe2,
    summary:
      "Shipping lanes beyond one country, including into the USA, with local handoffs and Merchant or Importer of Record support where the destination asks for an entity of record.",
    benefit: "Expand into a new market without hiring a local logistics team first.",
    points: [
      "Multi-country lanes",
      "Local handoff partners",
      "Landed-cost estimation",
      "Merchant/Importer of Record support",
    ],
  },
  {
    slug: "customs-compliance",
    name: "Customs & compliance",
    icon: FileCheck2,
    summary:
      "Customs paperwork and regulatory compliance handled with the shipment, including FDA and similar requirements, plus Merchant or Importer of Record support where a destination asks for an entity of record.",
    benefit: "The border paperwork stays with the same desk as the freight.",
    points: [
      "FDA and similar regulatory compliance",
      "HS code classification support",
      "Permit coordination",
      "Duty and tax documentation",
      "Merchant/Importer of Record",
    ],
  },
  {
    slug: "tech-integration",
    name: "Technology integration",
    icon: Cpu,
    summary:
      "API and file-based integration between your systems and IdealOne, our in-house operating platform — or skip integration entirely and run everything from the dashboard.",
    benefit: "Works for B2B and B2C clients, with or without integration.",
    points: ["Order and inventory feeds", "Webhook status updates", "No-integration dashboard access"],
  },
];

export function getServiceBySlug(slug: string) {
  return SERVICES.find((s) => s.slug === slug);
}
