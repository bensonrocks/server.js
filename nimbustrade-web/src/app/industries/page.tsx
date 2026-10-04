import { Industries } from "@/components/sections/industries";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Industries we pick, pack, and ship",
  description:
    "Fulfillment solutions for fashion, beauty, food, health, electronics, and media brands. Enquire about category handling, including FDA and similar compliance, with the merchants who run it.",
  path: "/industries",
});

export default function IndustriesPage() {
  return (
    <div className="pt-6">
      <Industries heading="h1" />
    </div>
  );
}
