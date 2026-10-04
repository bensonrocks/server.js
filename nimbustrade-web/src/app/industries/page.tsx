import { Industries } from "@/components/sections/industries";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Industries we fulfill",
  description:
    "Fulfillment for fashion, beauty, food, health, electronics, and media. Enquire about category handling, including FDA and similar compliance, from the Singapore desk.",
  path: "/industries",
});

export default function IndustriesPage() {
  return (
    <div className="pt-6">
      <Industries heading="h1" />
    </div>
  );
}
