import { SELF_RUN_MARKETS, formatMarketList } from "@/lib/site-config";
import { Reveal } from "@/components/reveal";

export function Credibility() {
  return (
    <section className="border-y border-border bg-paper-alt">
      <Reveal className="mx-auto max-w-7xl px-6 py-14">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          How the network is set up
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink">
          Warehouses in{" "}
          <span className="font-semibold">{formatMarketList(SELF_RUN_MARKETS)}</span> support
          ecommerce and retail enablement in those two markets — store
          replenishment, marketplace orders, and the stock behind them. Ecommerce
          fulfillment continues <span className="font-semibold">worldwide, including the USA</span>,
          through appointed partners. You still deal with one desk.
        </p>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
          <li>Inbound QC on every shipment</li>
          <li>Same-day dispatch cut-offs</li>
          <li>Compliance, including FDA and similar, handled with the shipment</li>
          <li>Real-time visibility through IdealOne</li>
        </ul>
      </Reveal>
    </section>
  );
}
