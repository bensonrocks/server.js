const STEPS = [
  {
    n: "01",
    title: "Scoping call",
    body: "We map your current flow — where stock sits, how orders arrive, and where the friction actually is.",
  },
  {
    n: "02",
    title: "Proposal & rate card",
    body: "A written scope and rate card against the service lines you need, with no bundled extras.",
  },
  {
    n: "03",
    title: "Onboarding",
    body: "Catalogue, inventory, and system integrations are set up before a single order is picked.",
  },
  {
    n: "04",
    title: "Go-live",
    body: "Orders start flowing through the operating desk, with a defined ramp period to reach full volume.",
  },
  {
    n: "05",
    title: "Ongoing reporting",
    body: "Recurring visibility into throughput, exceptions, and cost — the same numbers we work from.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <div className="max-w-2xl">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">How it works</span>
        <h2 className="mt-3 font-display text-4xl font-semibold text-ink">
          Five steps from first call to live operations.
        </h2>
      </div>

      <ol className="mt-12 max-w-3xl border-t border-border">
        {STEPS.map((step) => (
          <li
            key={step.n}
            className="grid grid-cols-[3.5rem_1fr] gap-x-4 border-b border-border py-6 sm:grid-cols-[4.5rem_12rem_1fr] sm:gap-x-8"
          >
            <span className="font-mono text-xs text-ink-muted">{step.n}</span>
            <h3 className="font-display text-xl font-semibold text-ink">{step.title}</h3>
            <p className="col-start-2 mt-2 text-sm leading-relaxed text-ink-muted sm:col-start-3 sm:mt-0">
              {step.body}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
