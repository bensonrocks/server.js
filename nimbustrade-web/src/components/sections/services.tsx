import Link from "next/link";
import { SERVICES } from "@/data/services";
import { Reveal } from "@/components/reveal";

export function Services() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="max-w-2xl">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">Services</span>
        <h2 className="mt-3 font-display text-4xl font-semibold text-ink">
          Pick, pack, and the lanes past the warehouse.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Orders are picked, packed, and dispatched from one inventory pool, then
          handed to freight when the lane leaves the country. Retail enablement in
          Singapore and Malaysia, ecommerce fulfillment worldwide including the USA,
          and the compliance that travels with the goods. Start with one line or
          hand the desk the lot.
        </p>
      </Reveal>

      <ol className="mt-12 border-t border-border">
        {SERVICES.map((service, i) => (
          <li key={service.slug} className="border-b border-border">
            <Link
              href={`/services#${service.slug}`}
              className="grid grid-cols-[3.5rem_1fr] gap-x-4 gap-y-2 py-6 sm:grid-cols-[4.5rem_14rem_1fr] sm:items-baseline sm:gap-x-8"
            >
              <span className="font-mono text-xs text-ink-muted">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="font-display text-xl font-semibold text-ink">{service.name}</h3>
              <div className="col-start-2 sm:col-start-3">
                <p className="text-sm leading-relaxed text-ink-muted">{service.summary}</p>
                <p className="mt-2 text-sm font-semibold text-ink">{service.benefit}</p>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
