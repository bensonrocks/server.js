"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const PATH_D =
  "M 20 170 C 90 60, 150 260, 230 150 S 340 40, 420 150 S 520 260, 580 130";

const NODES = [
  { x: 20, y: 170, label: "Origin factory" },
  { x: 230, y: 150, label: "NimbusTrade-appointed warehouse" },
  { x: 420, y: 150, label: "Port / airfreight gateway" },
  { x: 580, y: 130, label: "Last-mile destination" },
];

const SHIPMENTS = [
  { delay: 0, duration: 7 },
  { delay: 2.3, duration: 7 },
  { delay: 4.6, duration: 7 },
];

export function Hero() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative overflow-hidden bg-paper">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
        <div>
          <span className="inline-flex items-center gap-2 rounded-sm border border-border-strong bg-paper-alt px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand">
            Singapore · 4PL / 3PL operations
          </span>
          <h1 className="mt-6 font-display text-5xl font-bold leading-[1.05] text-ink sm:text-6xl">
            One control tower for warehousing, fulfilment, and freight.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
            NimbusTrade Solutions runs the operating layer between your suppliers and
            your customers — a single desk coordinating storage, pick-and-pack, customs,
            and cross-border transport so your team can focus on selling.
          </p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/quote">
                Get a quote <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/solutions">
                <PlayCircle className="h-4 w-4" /> Explore solutions
              </Link>
            </Button>
          </div>
          <dl className="mt-12 grid grid-cols-3 gap-6 border-t border-border pt-8">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Markets on file
              </dt>
              <dd className="mt-1 font-display text-3xl font-bold text-ink">13</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Operating desk
              </dt>
              <dd className="mt-1 font-display text-3xl font-bold text-ink">1</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Service lines
              </dt>
              <dd className="mt-1 font-display text-3xl font-bold text-ink">8</dd>
            </div>
          </dl>
        </div>

        <div className="relative">
          <div className="rounded-lg border border-border bg-paper-alt p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                Live shipment path
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-confirm">
                <span className="h-1.5 w-1.5 rounded-full bg-confirm animate-pulse" />
                Simulated
              </span>
            </div>
            <svg viewBox="0 0 600 260" className="w-full h-auto" role="img" aria-label="Animated diagram of a shipment moving from origin factory through a NimbusTrade-appointed warehouse and freight gateway to its final destination">
              <path
                d={PATH_D}
                fill="none"
                stroke="var(--color-border-strong)"
                strokeWidth={2}
                strokeDasharray="1 8"
                strokeLinecap="round"
              />

              {!reduceMotion &&
                SHIPMENTS.map((s, i) => (
                  <motion.circle
                    key={i}
                    r={6}
                    fill="var(--color-brand-bright)"
                    style={{ offsetPath: `path('${PATH_D}')` }}
                    initial={{ offsetDistance: "0%", opacity: 0 }}
                    animate={{ offsetDistance: "100%", opacity: [0, 1, 1, 0] }}
                    transition={{
                      duration: s.duration,
                      delay: s.delay,
                      repeat: Infinity,
                      ease: "linear",
                    }}
                  />
                ))}

              {NODES.map((n, i) => (
                <g key={i}>
                  <circle cx={n.x} cy={n.y} r={7} fill="var(--color-paper)" stroke="var(--color-brand)" strokeWidth={2.5} />
                  <circle cx={n.x} cy={n.y} r={2.5} fill="var(--color-brand)" />
                </g>
              ))}
            </svg>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              {NODES.map((n, i) => (
                <div key={i} className="text-[11px] leading-tight text-ink-muted">
                  <span className="block font-mono text-brand">{String(i + 1).padStart(2, "0")}</span>
                  {n.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
