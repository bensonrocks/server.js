import { SolutionsSelector } from "@/components/sections/solutions-selector";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Internationalization solutions for brands",
  description:
    "Internationalization solutions for brands entering a new market, including the USA. Pick and pack, freight, and the order workflow sit with the same merchants. Retail enablement in Singapore and Malaysia. Enquire to start.",
  path: "/solutions",
});

export default function SolutionsPage() {
  return (
    <div className="pt-6">
      <SolutionsSelector heading="h1" />
    </div>
  );
}
