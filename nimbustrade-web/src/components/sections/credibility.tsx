import { SELF_RUN_MARKETS, PARTNER_MARKETS, formatMarketList } from "@/lib/site-config";
import { Reveal } from "@/components/reveal";

export function Credibility() {
  return (
    <section className="border-y border-border bg-paper-alt">
      <Reveal className="mx-auto max-w-7xl px-6 py-14">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Fulfillment network
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink">
          We run our own warehouses in{" "}
          <span className="font-semibold">{formatMarketList(SELF_RUN_MARKETS)}</span>, and
          coordinate fulfillment onward through a panel of{" "}
          <span className="font-semibold">NimbusTrade-appointed partners</span> across{" "}
          {formatMarketList(PARTNER_MARKETS)} — every partner held to the same fulfillment
          standards. You deal with one desk either way.
        </p>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
          <li>Inbound QC on every shipment</li>
          <li>Same-day dispatch cut-offs</li>
          <li>Real-time visibility through IdealOne</li>
        </ul>
      </Reveal>
    </section>
  );
}
