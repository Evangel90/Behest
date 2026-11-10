"use client";
// Small motion helpers. MotionConfig (in Providers) honours prefers-reduced-motion.
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

export { AnimatePresence, motion };

export const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Fades and lifts its children into view once, when scrolled to. */
export function Reveal({ children, delay = 0, className, y = 16, ...p }: { children: ReactNode; delay?: number; className?: string; y?: number } & Omit<HTMLMotionProps<"div">, "children">) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
      transition={{ duration: 0.5, ease: EASE, delay }}
      className={className}
      {...p}
    >
      {children}
    </motion.div>
  );
}

/** Staggered entrance for a list; wrap each child in <StaggerItem>. */
export function Stagger({ children, className, as = "div", gap = 0.05 }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol"; gap?: number }) {
  const C = motion[as];
  return (
    <C initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: gap } } }} className={className}>
      {children}
    </C>
  );
}

export function StaggerItem({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "li" }) {
  const C = motion[as];
  return (
    <C variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.36, ease: EASE } } }} className={className}>
      {children}
    </C>
  );
}

/** Swaps content with a cross-fade when `id` changes (tabs, wizard steps). */
export function Swap({ id, children, className, dir = 1 }: { id: string; children: ReactNode; className?: string; dir?: number }) {
  return (
    <AnimatePresence mode="wait" initial={false} custom={dir}>
      <motion.div
        key={id}
        custom={dir}
        initial={{ opacity: 0, x: 16 * dir }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -12 * dir }}
        transition={{ duration: 0.24, ease: EASE }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
