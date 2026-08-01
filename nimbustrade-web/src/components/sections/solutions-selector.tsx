"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import { SOLUTIONS } from "@/data/solutions";
import { cn } from "@/lib/utils";

export function SolutionsSelector() {
  const [activeSlug, setActiveSlug] = React.useState(SOLUTIONS[0].slug);
  const active = SOLUTIONS.find((s) => s.slug === activeSlug) ?? SOLUTIONS[0];

  return (
    <section className="bg-paper-alt border-y border-border">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <div className="max-w-2xl">
          <span className="text-xs font-bold uppercase tracking-wider text-brand">
            Find your solution
          </span>
          <h2 className="mt-3 font-display text-4xl font-bold text-ink">
            What are you trying to solve right now?
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-ink-muted">
            Pick the closest description of what you need — the panel below updates instantly.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,320px)_1fr]">
          <div
            role="tablist"
            aria-label="Solutions"
            className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0"
          >
            {SOLUTIONS.map((s) => (
              <button
                key={s.slug}
                role="tab"
                aria-selected={s.slug === activeSlug}
                onClick={() => setActiveSlug(s.slug)}
                className={cn(
                  "shrink-0 rounded-sm border px-4 py-3 text-left text-sm font-semibold transition-colors lg:shrink",
                  s.slug === activeSlug
                    ? "border-brand bg-brand text-white"
                    : "border-border-strong bg-paper text-ink hover:border-brand hover:text-brand"
                )}
              >
                {s.name}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-border bg-paper p-8 min-h-[320px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={active.slug}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <p className="font-display text-xl font-semibold text-brand">
                  &ldquo;{active.question}&rdquo;
                </p>
                <h3 className="mt-3 font-display text-3xl font-bold text-ink">{active.name}</h3>
                <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-muted">
                  {active.description}
                </p>
                <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {active.included.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm text-ink">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-confirm" />
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
