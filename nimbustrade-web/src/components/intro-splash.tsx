"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ShoppingCart, Ship, Truck, PackageCheck } from "lucide-react";
import { WaveMark } from "@/components/wave-mark";

const SEEN_KEY = "nt-intro-seen";

const STEPS = [
  { icon: ShoppingCart, label: "Order placed" },
  { icon: Ship, label: "Freight moves" },
  { icon: Truck, label: "Last-mile" },
  { icon: PackageCheck, label: "Delivered" },
];

function ConnectorLine({ delay }: { delay: number }) {
  return (
    <motion.span
      className="relative mb-5 h-px w-6 overflow-visible bg-border-strong sm:w-10"
      initial={{ scaleX: 0 }}
      animate={{ scaleX: 1 }}
      style={{ transformOrigin: "left" }}
      transition={{ duration: 0.35, delay }}
    >
      <motion.span
        className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-brand-bright"
        initial={{ left: "0%", opacity: 0 }}
        animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
        transition={{
          duration: 1.1,
          delay: delay + 0.3,
          repeat: Infinity,
          repeatDelay: (STEPS.length - 1) * 0.35,
          ease: "easeInOut",
        }}
      />
    </motion.span>
  );
}

export function IntroSplash() {
  const reduceMotion = useReducedMotion();
  // "pending": SSR + first paint, before we know whether to play the intro —
  // renders a plain opaque cover so there's never a flash of raw page content.
  // "playing": animated intro is up. "done": nothing rendered.
  const [phase, setPhase] = React.useState<"pending" | "playing" | "done">("pending");

  React.useLayoutEffect(() => {
    let alreadySeen = true;
    try {
      alreadySeen = sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // sessionStorage unavailable — skip the intro rather than risk blocking render
    }

    if (alreadySeen || reduceMotion) {
      setPhase("done");
      return;
    }

    setPhase("playing");

    const dismiss = window.setTimeout(() => {
      setPhase("done");
      try {
        sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        // ignore
      }
    }, 2600);

    return () => window.clearTimeout(dismiss);
  }, [reduceMotion]);

  const skip = () => {
    setPhase("done");
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // ignore
    }
  };

  if (phase === "pending") {
    return <div className="fixed inset-0 z-[100] bg-paper" aria-hidden />;
  }

  return (
    <AnimatePresence>
      {phase === "playing" && (
        <motion.div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-paper"
          initial={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.03, y: -16 }}
          transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
        >
          <button
            type="button"
            onClick={skip}
            className="absolute right-6 top-6 text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-brand"
          >
            Skip
          </button>

          <div className="flex items-center gap-3 sm:gap-6">
            {STEPS.map((step, i) => (
              <React.Fragment key={step.label}>
                <motion.div
                  className="flex flex-col items-center gap-2"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.3 }}
                >
                  <motion.span
                    className="flex h-12 w-12 items-center justify-center rounded-full border border-border-strong bg-paper-alt sm:h-14 sm:w-14"
                    animate={{ scale: [1, 1.08, 1] }}
                    transition={{
                      duration: 0.5,
                      delay: i * 0.35 + 0.55,
                      repeat: Infinity,
                      repeatDelay: STEPS.length * 0.35,
                    }}
                  >
                    <step.icon className="h-5 w-5 text-brand sm:h-6 sm:w-6" />
                  </motion.span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted sm:text-xs">
                    {step.label}
                  </span>
                </motion.div>
                {i < STEPS.length - 1 && <ConnectorLine delay={i * 0.3 + 0.2} />}
              </React.Fragment>
            ))}
          </div>

          <motion.div
            className="mt-10 flex items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: STEPS.length * 0.3 }}
          >
            <WaveMark className="h-6 w-auto text-brand" />
            <span className="font-display text-sm font-bold tracking-[0.1em] text-brand">
              NIMBUSTRADE SOLUTIONS
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
