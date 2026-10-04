import { PricingSignal } from "@/components/sections/pricing-signal";
import { ContactSection } from "@/components/sections/contact-section";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Enquire about pick and pack fulfillment",
  description:
    "Send an enquiry to info@nimbustrade.co. Ask about pick and pack, Singapore and Malaysia retail enablement, worldwide ecommerce including the USA, or compliance including FDA.",
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
