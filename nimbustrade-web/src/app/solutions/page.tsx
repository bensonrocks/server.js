import type { Metadata } from "next";
import { SolutionsSelector } from "@/components/sections/solutions-selector";

export const metadata: Metadata = {
  title: "Fulfillment Solutions for B2B & B2C Brands in Southeast Asia",
  description:
    "Find the right fulfillment solution for your brand — warehousing, fulfilment, freight, distribution, e-commerce operations, cross-border expansion, customs, or platform integration.",
  alternates: { canonical: "/solutions" },
};

export default function SolutionsPage() {
  return (
    <div className="pt-6">
      <h1 className="sr-only">Fulfillment Solutions for B2B & B2C Brands in Southeast Asia</h1>
      <SolutionsSelector />
    </div>
  );
}
