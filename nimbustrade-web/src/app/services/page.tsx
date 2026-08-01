import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SERVICES } from "@/data/services";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Services — NimbusTrade Solutions" };

export default function ServicesPage() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-20">
      <div className="max-w-2xl">
        <span className="text-xs font-bold uppercase tracking-wider text-brand">Services</span>
        <h1 className="mt-3 font-display text-5xl font-bold text-ink">
          Every service line, in detail.
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Start with one, or combine several — each service below plugs into the same operating
          desk and reporting.
        </p>
      </div>

      <div className="mt-14 space-y-10">
        {SERVICES.map((service) => (
          <section
            key={service.slug}
            id={service.slug}
            className="scroll-mt-24 grid grid-cols-1 gap-8 rounded-lg border border-border bg-paper-alt p-8 lg:grid-cols-[auto_1fr_auto] lg:items-center"
          >
            <service.icon className="h-10 w-10 text-brand" />
            <div>
              <h2 className="font-display text-2xl font-bold text-ink">{service.name}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
                {service.summary}
              </p>
              <p className="mt-3 text-sm font-semibold text-brand">{service.benefit}</p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {service.points.map((p) => (
                  <li
                    key={p}
                    className="rounded-sm bg-paper px-3 py-1 text-xs font-medium text-ink-muted border border-border"
                  >
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link href="/quote">
                Get a quote <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </section>
        ))}
      </div>
    </div>
  );
}
