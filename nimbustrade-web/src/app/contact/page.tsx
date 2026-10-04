import { PricingSignal } from "@/components/sections/pricing-signal";
import { ContactSection } from "@/components/sections/contact-section";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Enquire about fulfillment",
  description:
    "Send an enquiry to the NimbusTrade desk in Singapore. Ask about retail enablement in Singapore and Malaysia, worldwide fulfillment including the USA, or compliance including FDA.",
  path: "/contact",
});

export default function ContactPage() {
  return (
    <>
      <ContactSection heading="h1" />
      <PricingSignal />
    </>
  );
}
