import type { Metadata } from "next";
import { Industries } from "@/components/sections/industries";

export const metadata: Metadata = {
  title: "Industries We Fulfill For Across Southeast Asia",
  description:
    "Fashion, beauty, food & beverage, health & wellness, consumer electronics, and books & media — fulfillment built around each category's real operational requirements.",
  alternates: { canonical: "/industries" },
};

export default function IndustriesPage() {
  return (
    <div className="pt-6">
      <h1 className="sr-only">Industries We Fulfill For Across Southeast Asia</h1>
      <Industries />
    </div>
  );
}
