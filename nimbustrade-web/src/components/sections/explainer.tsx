"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { FileCheck2, Globe2, PackageCheck, Store, Warehouse, type LucideIcon } from "lucide-react";

const HOLD_MS = 2800;

interface Chapter {
  n: string;
  title: string;
  body: string;
  icon: LucideIcon;
}

const CHAPTERS: Chapter[] = [
  {
    n: "01",
    title: "Merchants who run it",
    body: "We run fulfillment, retail enablement, and logistics ourselves. We are merchants ourselves, so we know this work from the inside.",
    icon: Store,
  },
  {
    n: "02",
    title: "Singapore and Malaysia",
    body: "Retail enablement sits in the warehouses we run ourselves, in Singapore and Malaysia: store replenishment, marketplace orders, and the stock behind them.",
    icon: Warehouse,
  },
  {
    n: "03",
    title: "Worldwide, including the USA",
    body: "Ecommerce fulfillment continues worldwide, including the USA, through appointed partners, so stock can sit closer to the buyer.",
    icon: Globe2,
  },
  {
    n: "04",
    title: "Pick, pack, dispatch",
    body: "Marketplace and storefront orders are picked, packed, and dispatched from one inventory pool.",
    icon: PackageCheck,
  },
  {
    n: "05",
    title: "Compliance with the shipment",
    body: "FDA and similar regulatory work travel with the goods. Write to info@nimbustrade.co when you want it scoped.",
    icon: FileCheck2,
  },
];

export function Explainer() {
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  // useReducedMotion() is null during SSR and on the first client render.
  // Branching the markup on it hydrates a different tree once the real
  // preference arrives, so motion only starts after mount.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  const animate = ready && !reduceMotion && !paused;

  React.useEffect(() => {
    if (!animate) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % CHAPTERS.length);
    }, HOLD_MS);
    return () => window.clearInterval(id);
  }, [animate, index]);

  return (
    <section
      id="explainer"
      aria-labelledby="explainer-heading"
      className="border-b border-border bg-paper"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <div className="mx-auto max-w-7xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">The operation</p>
        <h2 id="explainer-heading" className="mt-3 max-w-3xl font-display text-4xl font-semibold text-ink">
          Fulfillment, retail enablement, and logistics — run by merchants.
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-muted">
          A short sequence of how the company actually runs: the work, the markets, and where to enquire.
        </p>

        <ol className="mt-10 border-t border-border">
          {CHAPTERS.map((chapter, i) => {
            const selected = i === index;
            const Icon = chapter.icon;
            return (
              <li key={chapter.n} className="border-b border-border">
                <button
                  type="button"
                  aria-current={selected ? "step" : undefined}
                  onClick={() => setIndex(i)}
                  className="grid w-full grid-cols-[3.5rem_1fr] gap-x-4 py-6 text-left sm:grid-cols-[4.5rem_1fr] sm:gap-x-8"
                >
                  <span className="flex flex-col items-start gap-3">
                    <span className="font-mono text-xs text-ink-muted">{chapter.n}</span>
                    <span
                      className={`block h-8 w-px ${selected ? "bg-brand" : "bg-border"}`}
                      aria-hidden
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-3">
                      <Icon className={`h-5 w-5 shrink-0 ${selected ? "text-brand" : "text-ink-muted"}`} aria-hidden />
                      <span className={`font-display text-xl font-semibold sm:text-2xl ${selected ? "text-ink" : "text-ink-muted"}`}>
                        {chapter.title}
                      </span>
                    </span>
                    <span className="mt-3 block max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
                      {chapter.body}
                    </span>
                    {selected ? (
                      <span className="mt-4 block h-px w-full max-w-xs overflow-hidden bg-border" aria-hidden>
                        <motion.span
                          key={`bar-${chapter.n}-${animate ? "run" : "hold"}`}
                          className="block h-px origin-left bg-brand"
                          initial={{ scaleX: animate ? 0 : 1 }}
                          animate={{ scaleX: 1 }}
                          transition={{ duration: animate ? HOLD_MS / 1000 : 0, ease: "linear" }}
                        />
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <p className="mt-8 text-sm text-ink-muted">
          Enquire at{" "}
          <a href="mailto:info@nimbustrade.co" className="font-semibold text-ink hover:text-brand">
            info@nimbustrade.co
          </a>
          , or{" "}
          <Link href="/quote" className="font-semibold text-ink underline decoration-border-strong underline-offset-4 hover:text-brand hover:decoration-brand">
            get a quote
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
