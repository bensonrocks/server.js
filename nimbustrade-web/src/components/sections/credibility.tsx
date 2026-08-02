export function Credibility() {
  return (
    <section className="border-y border-border bg-paper-alt">
      <div className="mx-auto max-w-7xl px-6 py-14">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Fulfillment network
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink">
          Goods move through <span className="font-semibold">NimbusTrade-appointed warehouses</span>
          {" "}across <span className="font-semibold">Singapore</span> and{" "}
          <span className="font-semibold">Malaysia</span> — every partner warehouse is held to the
          same fulfillment standards, so where an appointed partner is the better fit for your
          lane, we route there instead. You deal with one desk either way.
        </p>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
          <li>Inbound QC on every shipment</li>
          <li>Same-day dispatch cut-offs</li>
          <li>Real-time visibility through IdealOne</li>
        </ul>
      </div>
    </section>
  );
}
