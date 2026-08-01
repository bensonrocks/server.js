import type { LucideIcon } from "lucide-react";
import { Shirt, Sparkles, UtensilsCrossed, HeartPulse, Component, BookOpen } from "lucide-react";

export interface Industry {
  name: string;
  icon: LucideIcon;
  description: string;
}

// Placeholder set — confirm which verticals NimbusTrade has real, citable
// experience in before publishing this list externally.
export const INDUSTRIES: Industry[] = [
  {
    name: "Fashion & apparel",
    icon: Shirt,
    description: "Size/colour variant handling, seasonal volume swings, and returns-heavy order profiles.",
  },
  {
    name: "Beauty & personal care",
    icon: Sparkles,
    description: "Batch and expiry tracking, fragile-item handling, and gift-set kitting.",
  },
  {
    name: "Food & beverage",
    icon: UtensilsCrossed,
    description: "Lot tracking and temperature-aware storage for shelf-life-sensitive goods.",
  },
  {
    name: "Health & wellness",
    icon: HeartPulse,
    description: "Serialised and batch-controlled stock with documentation on every movement.",
  },
  {
    name: "Consumer electronics",
    icon: Component,
    description: "Serial-number capture, warranty registration support, and secure high-value storage.",
  },
  {
    name: "Books & media",
    icon: BookOpen,
    description: "High-SKU-count catalogues with low unit value and high pick-density requirements.",
  },
];
