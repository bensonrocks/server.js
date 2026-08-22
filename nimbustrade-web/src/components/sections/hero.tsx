import Link from "next/link";
import { ArrowRight, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SELF_RUN_MARKETS, PARTNER_MARKETS, formatMarketList } from "@/lib/site-config";

const MANIFEST_FACTS = [
  { label: "Origin desk", value: "Singapore" },
  { label: "Self-run warehouses", value: formatMarketList(SELF_RUN_MARKETS) },
  { label: "Appointed-partner network", value: `${PARTNER_MARKETS.length} markets` },
  { label: "Shipment visibility", value: "Real-time, via IdealOne" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border bg-paper">
      <div className="mx-auto grid max-w-7xl gap-x-12 gap-y-10 px-6 pb-14 pt-16 lg:grid-cols-[7fr_5fr] lg:pb-0 lg:pt-24">
        <div className="lg:pb-20">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">
            NimbusTrade Solutions — Singapore
          </p>
          <h1 className="mt-5 max-w-2xl font-display text-4xl font-semibold leading-[1.08] text-ink sm:text-5xl lg:text-display-xl">
            The operating layer between your suppliers and your customers.
          </h1>
          <p className="mt-6 max-w-xl text-body-lg leading-relaxed text-ink-muted">
            We run storage, pick-and-pack, customs clearance, and cross-border
            transport as one system — for B2B and B2C brands moving goods across
            Southeast Asia and onward into international markets.
          </p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center">
            <Button asChild size="lg">
              <Link href="/quote">
                Get a quote <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Link
              href="/solutions"
              className="inline-flex items-center gap-2 text-sm font-semibold text-ink underline decoration-border-strong underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
            >
              <PlayCircle className="h-4 w-4" /> Explore solutions
            </Link>
          </div>
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
