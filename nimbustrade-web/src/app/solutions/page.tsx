import { SolutionsSelector } from "@/components/sections/solutions-selector";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Fulfillment for orders, expansion, and freight",
  description:
    "Tell NimbusTrade what you need solved: pick and pack, a new market including the USA, or the order workflow behind the stock. Retail enablement in Singapore and Malaysia, run by merchants.",
  path: "/solutions",
});

export default function SolutionsPage() {
  return (
    <div className="pt-6">
      <SolutionsSelector heading="h1" />
    </div>
  );
}
