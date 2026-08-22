"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

interface RevealProps {
  children: React.ReactNode;
  /** Stagger offset in seconds — cap the caller passes in at ~0.3s for larger groups. */
  delay?: number;
  /** Vertical travel distance in px. Larger reveals can afford a bit more. */
  y?: number;
  className?: string;
  id?: string;
}

/**
 * Scroll-triggered fade + rise, used for section headers and card grids.
 * Fires once per element (viewport: { once: true }) and collapses to a
 * plain opacity fade under prefers-reduced-motion.
 */
export function Reveal({ children, delay = 0, y = 20, className, id }: RevealProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      id={id}
      initial={{ opacity: 0, y: reduceMotion ? 0 : y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
