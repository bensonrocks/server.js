import type { Metadata } from "next";
import { ContactSection } from "@/components/sections/contact-section";

export const metadata: Metadata = { title: "Contact — NimbusTrade Solutions" };

export default function ContactPage() {
  return <ContactSection />;
}
