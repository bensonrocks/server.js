import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SERVICES } from "@/data/services";
import { Reveal } from "@/components/reveal";
import { staggerDelay } from "@/lib/motion";

export function Services() {
  const [featured1, featured2, ...rest] = SERVICES;

  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="max-w-2xl">
        <span className="text-xs font-bold uppercase tracking-wider text-brand">Services</span>
        <h2 className="mt-3 font-display text-4xl font-bold text-ink">
          Eight service lines, run as one operation.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Each service below can stand alone or plug into the others — most clients start with
          one or two and add more as they need them.
        </p>
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {[featured1, featured2].map((service, i) => (
          <Reveal key={service.slug} delay={staggerDelay(i)}>
            <Link
              href={`/services#${service.slug}`}
              className="group block h-full rounded-lg border border-border bg-paper p-8 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand hover:shadow-md motion-reduce:hover:translate-y-0"
            >
              <service.icon className="h-8 w-8 text-brand" />
              <h3 className="mt-5 font-display text-2xl font-bold text-ink">{service.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{service.summary}</p>
              <p className="mt-4 text-sm font-semibold text-brand">{service.benefit}</p>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-ink group-hover:text-brand">
                Learn more <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </span>
            </Link>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1} className="mt-6 divide-y divide-border rounded-lg border border-border bg-paper">
        {rest.map((service) => (
          <Link
            key={service.slug}
            href={`/services#${service.slug}`}
            className="group flex items-center gap-5 px-6 py-5 transition-colors hover:bg-paper-alt"
          >
            <service.icon className="h-6 w-6 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-lg font-semibold text-ink">{service.name}</h3>
              <p className="mt-0.5 truncate text-sm text-ink-muted">{service.summary}</p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-1 group-hover:text-brand" />
          </Link>
        ))}
      </Reveal>
    </section>
  );
}
