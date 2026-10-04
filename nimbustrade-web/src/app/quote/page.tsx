import { QuoteForm } from "@/components/sections/quote-form";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Get a fulfillment and logistics quote",
  description:
    "Request a quote for fulfillment solutions, logistics solutions, or internationalization solutions for brands entering a new market. Singapore and Malaysia retail enablement, ecommerce fulfillment worldwide including the USA, and compliance including FDA.",
  path: "/quote",
});

export default function QuotePage() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20">
      <div className="mb-12 max-w-2xl">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">Get a quote</span>
        <h1 className="mt-3 font-display text-4xl font-semibold text-ink sm:text-5xl">
          Tell us what you need moved or stored.
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Six short steps — most people finish in under two minutes. Ask about
          fulfillment solutions, logistics solutions, or internationalization
          solutions for brands entering a new market, including retail enablement in
          Singapore and Malaysia, ecommerce fulfillment worldwide including the USA,
          or compliance including FDA. Prefer email? Write to{" "}
          <a href="mailto:info@nimbustrade.co" className="font-semibold text-ink hover:text-brand">
            info@nimbustrade.co
          </a>
          .
        </p>
      </div>
      <QuoteForm />
    </section>
  );
}
