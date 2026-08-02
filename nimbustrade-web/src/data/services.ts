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
      "Storage across NimbusTrade-appointed warehouses in Singapore and Malaysia, every one held to the same fulfillment standards.",
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
      "Last-mile and regional distribution across Southeast Asia, coordinated with local carrier partners.",
    benefit: "A single delivery SLA across every market you sell into.",
    points: ["Route planning", "Proof of delivery capture", "Regional carrier panel"],
  },
  {
    slug: "e-commerce-operations",
    name: "E-commerce operations",
    icon: ShoppingCart,
    summary:
      "Marketplace and storefront order operations, supported via file upload so nothing needs re-keying — API sync where a connector is already in place.",
    benefit: "Orders flow to the warehouse floor without manual re-keying.",
    points: ["Order intake", "Inventory allocation", "Channel-level reporting"],
  },
  {
    slug: "cross-border",
    name: "Cross-border logistics",
    icon: Globe2,
    summary:
      "Multi-market shipping lanes for brands expanding beyond a single country, with local-market handoffs.",
    benefit: "Expand into a new market without hiring a local logistics team first.",
    points: ["Multi-country lanes", "Local handoff partners", "Landed-cost estimation"],
  },
  {
    slug: "customs-compliance",
    name: "Customs & compliance",
    icon: FileCheck2,
    summary:
      "Documentation and customs coordination handled alongside your shipment, not as a separate vendor relationship.",
    benefit: "Fewer parties to chase when a shipment is held at the border.",
    points: ["HS code classification support", "Permit coordination", "Duty and tax documentation"],
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
