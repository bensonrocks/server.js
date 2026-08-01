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
            Certifications &amp; partner accreditations
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {["[ Certification — placeholder ]", "[ Certification — placeholder ]", "[ Carrier partnership — placeholder ]"].map(
              (label) => (
                <span
                  key={label}
                  className="rounded-sm border border-dashed border-border-strong px-3 py-1.5 text-xs font-medium text-ink-muted"
                >
                  {label}
                </span>
              )
            )}
          </div>
          <p className="mt-3 text-xs text-ink-muted/80">
            Placeholders shown until specific certifications are confirmed for publication.
          </p>
        </div>
      </div>
    </section>
  );
}
