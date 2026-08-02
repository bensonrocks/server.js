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

export function IntroSplash() {
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let alreadySeen = true;
    try {
      alreadySeen = sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // sessionStorage unavailable — skip the intro rather than risk blocking render
    }

    if (alreadySeen || reduceMotion) {
      setReady(true);
      return;
    }

    setVisible(true);
    setReady(true);

    const dismiss = window.setTimeout(() => {
      setVisible(false);
      try {
        sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        // ignore
      }
    }, 2600);

    return () => window.clearTimeout(dismiss);
  }, [reduceMotion]);

  const skip = () => {
    setVisible(false);
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // ignore
    }
  };

  if (!ready) return null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-paper"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
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
                  <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border-strong bg-paper-alt sm:h-14 sm:w-14">
                    <step.icon className="h-5 w-5 text-brand sm:h-6 sm:w-6" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted sm:text-xs">
                    {step.label}
                  </span>
                </motion.div>
                {i < STEPS.length - 1 && (
                  <motion.span
                    className="mb-5 h-px w-6 bg-border-strong sm:w-10"
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    style={{ transformOrigin: "left" }}
                    transition={{ duration: 0.35, delay: i * 0.3 + 0.2 }}
                  />
                )}
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
