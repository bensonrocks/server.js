import { INDUSTRIES } from "@/data/industries";
import { Reveal } from "@/components/reveal";

export function Industries({ heading = "h2" }: { heading?: "h1" | "h2" }) {
  const Title = heading;
  return (
    <section className="border-y border-border bg-paper-alt">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <Reveal className="max-w-2xl">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">Industries</span>
          <Title className="mt-3 font-display text-4xl font-semibold text-ink">
            Built around categories with real operational quirks.
          </Title>
          <p className="mt-4 text-lg leading-relaxed text-ink-muted">
            Every category below needs something different from a warehouse. Regulated
            goods — FDA and similar — are handled on the compliance line, not left as
            a separate vendor.
          </p>
        </Reveal>

        <dl className="mt-12 border-t border-border">
          {INDUSTRIES.map((industry) => (
            <div
              key={industry.name}
              className="grid grid-cols-1 gap-2 border-b border-border py-5 sm:grid-cols-[16rem_1fr] sm:gap-10"
            >
              <dt className="font-display text-lg font-semibold text-ink">{industry.name}</dt>
              <dd className="text-sm leading-relaxed text-ink-muted">{industry.description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
