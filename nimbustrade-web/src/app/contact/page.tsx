import { PricingSignal } from "@/components/sections/pricing-signal";
import { ContactSection } from "@/components/sections/contact-section";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Enquire about fulfillment and logistics solutions",
  description:
    "Send an enquiry to info@nimbustrade.co about fulfillment solutions, logistics solutions, or internationalization solutions for brands. Singapore and Malaysia retail enablement, worldwide ecommerce including the USA, and compliance including FDA.",
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
