import Link from "next/link";
import { SERVICES } from "@/data/services";
import { ServiceJsonLd } from "@/components/structured-data";
import { marketingMeta } from "@/lib/site-config";

export const metadata = marketingMeta({
  title: "Pick, pack, freight, and compliance",
  description:
    "Enquire about pick and pack, marketplace orders, cross-border lanes including the USA, and compliance including FDA. NimbusTrade runs retail enablement in Singapore and Malaysia.",
  path: "/services",
});

export default function ServicesPage() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-20">
      <ServiceJsonLd services={SERVICES} />
      <div className="max-w-2xl">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">Services</span>
        <h1 className="mt-3 font-display text-5xl font-semibold text-ink">
          Every service line, in detail.
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Pick, pack, and dispatch from one inventory pool, then freight and
          compliance with the same people. Retail enablement in Singapore and Malaysia,
          ecommerce fulfillment worldwide including the USA, and regulatory work —
          including FDA and similar — handled with the shipment. Start with one
          line, or hand over several.
        </p>
      </div>

      <div className="mt-14 border-t border-border">
        {SERVICES.map((service, i) => (
          <section
            key={service.slug}
            id={service.slug}
            className="scroll-mt-24 grid grid-cols-1 gap-4 border-b border-border py-8 sm:grid-cols-[4.5rem_1fr] sm:gap-8"
          >
            <p className="font-mono text-xs text-ink-muted">{String(i + 1).padStart(2, "0")}</p>
            <div>
              <h2 className="font-display text-2xl font-semibold text-ink">{service.name}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
                {service.summary}
              </p>
              <p className="mt-3 text-sm font-semibold text-ink">{service.benefit}</p>
              <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
                {service.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <Link
                href="/quote"
                className="mt-5 inline-block text-sm font-semibold text-ink underline decoration-border-strong underline-offset-4 hover:text-brand hover:decoration-brand"
              >
                Get a quote
              </Link>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
