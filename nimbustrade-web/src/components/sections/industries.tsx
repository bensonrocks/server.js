import { INDUSTRIES } from "@/data/industries";

export function Industries() {
  return (
    <section className="bg-paper-alt border-y border-border">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <div className="max-w-2xl">
          <span className="text-xs font-bold uppercase tracking-wider text-brand">Industries</span>
          <h2 className="mt-3 font-display text-4xl font-bold text-ink">
            Built around categories with real operational quirks.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-ink-muted">
            Every category below needs something different from a warehouse — here&rsquo;s what
            we account for.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {INDUSTRIES.map((industry) => (
            <div key={industry.name} className="bg-paper p-7">
              <industry.icon className="h-6 w-6 text-brand" />
              <h3 className="mt-4 font-display text-lg font-bold text-ink">{industry.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{industry.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
