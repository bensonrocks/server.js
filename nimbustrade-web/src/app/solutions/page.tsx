import { SolutionsSelector } from "@/components/sections/solutions-selector";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Choose a fulfillment service",
  description:
    "Tell NimbusTrade what you need solved. Retail enablement in Singapore and Malaysia, ecommerce fulfillment worldwide including the USA, and compliance including FDA, from one desk.",
  path: "/solutions",
});

export default function SolutionsPage() {
  return (
    <div className="pt-6">
      <SolutionsSelector heading="h1" />
    </div>
  );
}
