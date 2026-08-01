import { CASE_STUDIES } from "@/data/case-studies";

export function CaseStudies() {
  return (
    <section className="bg-paper-alt border-y border-border">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <span className="text-xs font-bold uppercase tracking-wider text-brand">Case studies</span>
            <h2 className="mt-3 font-display text-4xl font-bold text-ink">
              How engagements like these typically play out.
            </h2>
          </div>
        </div>
        <p className="mt-4 max-w-2xl rounded-sm border border-dashed border-border-strong bg-paper px-4 py-3 text-sm text-ink-muted">
          The three write-ups below are illustrative placeholders pending confirmed client
          details and sign-off — not real client engagements.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {CASE_STUDIES.map((cs) => (
            <article
              key={cs.slug}
              className="flex flex-col rounded-lg border border-border bg-paper p-7"
            >
              <span className="text-xs font-bold uppercase tracking-wider text-brand">
                {cs.industry}
              </span>
              <h3 className="mt-2 font-display text-xl font-bold text-ink">{cs.client}</h3>

              <div className="mt-5 space-y-4 text-sm leading-relaxed text-ink-muted">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-ink">Challenge</p>
                  <p className="mt-1">{cs.challenge}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-ink">Solution</p>
                  <p className="mt-1">{cs.solution}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-ink">Approach</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {cs.approach.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <p className="mt-5 rounded-sm bg-brand-tint px-3 py-2 text-sm font-semibold text-brand">
                {cs.result}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
