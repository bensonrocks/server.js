import type { Metadata } from "next";
import { PricingSignal } from "@/components/sections/pricing-signal";
import { ContactSection } from "@/components/sections/contact-section";

export const metadata: Metadata = {
  title: "Contact Our Singapore Fulfillment Desk",
  description:
    "Reach the NimbusTrade Solutions operating desk in Singapore — email, phone, WhatsApp, or a message form for ecommerce fulfillment enquiries across Southeast Asia.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <>
      <h1 className="sr-only">Contact Our Singapore Fulfillment Desk</h1>
      <PricingSignal />
      <ContactSection />
    </>
  );
}
