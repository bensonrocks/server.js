import type { Metadata } from "next";
import { QuoteForm } from "@/components/sections/quote-form";

export const metadata: Metadata = {
  title: "Get a Fulfillment Quote for Southeast Asia",
  description:
    "Get a fulfillment quote from NimbusTrade Solutions in six short steps — warehousing, freight, distribution, or e-commerce operations across our self-run Singapore and Malaysia network and our wider international partner markets.",
  alternates: { canonical: "/quote" },
};

export default function QuotePage() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <span className="text-xs font-bold uppercase tracking-wider text-brand">Get a quote</span>
        <h1 className="mt-3 font-display text-4xl font-bold text-ink sm:text-5xl">
          Tell us what you need moved or stored.
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Six short steps — most people finish in under two minutes.
        </p>
      </div>
      <QuoteForm />
    </section>
  );
}
