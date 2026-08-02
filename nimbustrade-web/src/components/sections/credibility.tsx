import { ShieldCheck, Boxes, Globe2, Users } from "lucide-react";

const STATS = [
  { icon: Globe2, value: "13", label: "Markets on file" },
  { icon: Boxes, value: "8", label: "Service lines coordinated" },
  { icon: Users, value: "1", label: "Operating desk, Singapore" },
  { icon: ShieldCheck, value: "24/7", label: "Shipment visibility" },
];

export function Credibility() {
  return (
    <section className="border-y border-border bg-paper-alt">
      <div className="mx-auto max-w-7xl px-6 py-14">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="flex flex-col items-start gap-2">
              <s.icon className="h-5 w-5 text-brand" />
              <span className="font-display text-3xl font-bold text-ink">{s.value}</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {s.label}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-10 border-t border-border pt-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Fulfillment network
          </p>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink">
            Goods move through <span className="font-semibold">NimbusTrade-appointed warehouses</span>
            {" "}— not just one distribution centre. Every partner warehouse, including our own
            facilities in <span className="font-semibold">Singapore</span> and{" "}
            <span className="font-semibold">Malaysia</span>, is held to the same fulfillment
            standards.
          </p>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
            <li>Inbound QC on every shipment</li>
            <li>Same-day dispatch cut-offs</li>
            <li>Real-time visibility through IdealOne</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
