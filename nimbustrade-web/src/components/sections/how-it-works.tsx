"use client";

import { motion } from "framer-motion";

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
        <span className="text-xs font-bold uppercase tracking-wider text-brand">How it works</span>
        <h2 className="mt-3 font-display text-4xl font-bold text-ink">
          Five steps from first call to live operations.
        </h2>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-5">
        {STEPS.map((step, i) => (
          <motion.div
            key={step.n}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.5, delay: i * 0.08 }}
            className="relative"
          >
            <span className="font-display text-5xl font-bold text-brand-tint">{step.n}</span>
            <h3 className="mt-2 font-display text-xl font-bold text-ink">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{step.body}</p>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className="hidden md:block absolute top-6 left-[calc(100%+1rem)] h-px w-8 bg-border-strong"
              />
            )}
          </motion.div>
        ))}
      </div>
    </section>
  );
}
