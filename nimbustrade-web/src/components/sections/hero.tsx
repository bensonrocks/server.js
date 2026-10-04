import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SELF_RUN_MARKETS, formatMarketList } from "@/lib/site-config";

const MANIFEST_FACTS = [
  { label: "Retail enablement", value: formatMarketList(SELF_RUN_MARKETS) },
  { label: "Ecommerce fulfillment", value: "Worldwide, including the USA" },
  { label: "Compliance", value: "FDA and similar, handled here" },
  { label: "Shipment visibility", value: "Real-time, via IdealOne" },
];

export function Hero() {
  return (
    <section className="border-b border-border bg-paper">
      <div className="bg-brand-strong text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-6 py-3 font-mono text-[11px] uppercase tracking-[0.14em] sm:flex-row sm:items-center sm:justify-between">
          <p>Singapore · fulfillment we run ourselves</p>
          <a href="mailto:info@nimbustrade.co" className="text-white/80 hover:text-white">
            Enquire · info@nimbustrade.co
          </a>
        </div>
      </div>
      <div className="mx-auto grid max-w-7xl gap-x-12 gap-y-10 px-6 pb-14 pt-16 lg:grid-cols-[7fr_5fr] lg:pb-0 lg:pt-20">
        <div className="lg:pb-20">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">
            NimbusTrade Solutions — run by merchants
          </p>
          <h1 className="mt-5 max-w-2xl font-display text-4xl font-semibold leading-[1.08] text-ink sm:text-5xl lg:text-display-xl">
            We run fulfillment, retail enablement, and logistics.
          </h1>
          <p className="mt-5 max-w-xl font-display text-xl leading-snug text-ink sm:text-2xl">
            We are merchants ourselves, so we know this work from the inside.
          </p>
          <p className="mt-6 max-w-xl text-body-lg leading-relaxed text-ink-muted">
            NimbusTrade is the one-stop for the job, and it is run by merchants.
            Pick, pack, and dispatch for marketplace and storefront orders, against
            one inventory pool. Retail enablement in Singapore and Malaysia.
            Ecommerce fulfillment worldwide, including the USA, through appointed
            partners, so stock can sit closer to the buyer. Storage, freight,
            duties, and compliance — including FDA and similar regulatory work —
            sit with the same people.
          </p>
          <p className="mt-4 max-w-xl text-body-lg leading-relaxed text-ink-muted">
            A brand looking to expand can enquire for fulfillment solutions on the
            orders, logistics solutions on the freight, and internationalization
            solutions for the market it is entering.
          </p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center">
            <Button asChild size="lg">
              <Link href="/quote">
                Get a quote <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 text-sm font-semibold text-ink underline decoration-border-strong underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
            >
              Send an enquiry
            </Link>
          </div>
          <p className="mt-4 text-sm text-ink-muted">
            Or write to{" "}
            <a href="mailto:info@nimbustrade.co" className="font-semibold text-ink hover:text-brand">
              info@nimbustrade.co
            </a>
            .
          </p>
        </div>

        <div className="border-t border-border pb-14 pt-6 lg:border-l lg:border-t-0 lg:py-8 lg:pl-10">
          <dl className="flex flex-col">
            {MANIFEST_FACTS.map((fact) => (
              <div
                key={fact.label}
                className="flex items-baseline justify-between gap-6 border-b border-border py-4 first:pt-0 last:border-b-0"
              >
                <dt className="font-mono text-xs uppercase tracking-[0.08em] text-ink-muted">
                  {fact.label}
                </dt>
                <dd className="text-right text-sm font-semibold text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
