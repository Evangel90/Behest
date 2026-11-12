"use client";
// The brand loader (public/brand/behest-loader.svg), inlined so its colours
// follow the app's theme. Geometry as in the file; the ring and the overlap it
// makes with the disc (class "p") slide out and back every 1.8s.
//
// Sizes: 20 inline (buttons, rows), 48 for sections and cards, 84 for whole
// pages and route changes. It appears only after 150ms, so fast loads don't
// flash, and stands still for people who prefer reduced motion.
import { useEffect, useId, useState } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * Which surface it sits on:
 * - theme: the page (black on light, white on dark; follows the theme toggle)
 * - inverse: the opposite of the page (an ink button, the toast)
 * - light / dark: a surface that never changes (a white QR card, the sidebar, a blue button)
 */
export type LoaderTone = "theme" | "inverse" | "light" | "dark";

export function BehestLoader({
  size = 48,
  label = "Loading",
  showLabel = false,
  tone = "theme",
  delay = 150,
  className,
}: {
  size?: 20 | 48 | 84 | number;
  label?: string;
  /** Show the label under the mark (screen readers always get it). */
  showLabel?: boolean;
  tone?: LoaderTone;
  /** ms before it appears. */
  delay?: number;
  className?: string;
}) {
  const id = useId();
  const [shown, setShown] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return;
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <span role="status" aria-live="polite" className={cx("behest-loader inline-flex shrink-0 flex-col items-center gap-2", `behest-loader--${tone}`, className)}>
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false" style={{ visibility: shown ? "visible" : "hidden" }}>
        <clipPath id={id}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
        <circle className="m" cx="32" cy="32" r="32" />
        <g clipPath={`url(#${id})`}>
          <circle className="l p" cx="60" cy="60" r="24" />
        </g>
        <circle className="r p" cx="60" cy="60" r="21" />
      </svg>
      <span className={showLabel && shown ? "text-sm text-muted" : "sr-only"}>{label}</span>
    </span>
  );
}

/** Full-page and route-transition loading: the 84px mark, centred. */
export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center">
      <BehestLoader size={84} label={label} />
    </div>
  );
}

/**
 * The loader as a large, faint background watermark (the landing hero).
 * Decorative only: hidden from assistive tech, theme-coloured, and it drifts
 * at a slower pace than the loader (still under reduced motion).
 */
export function BehestWatermark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className={cx("behest-loader behest-loader--theme behest-watermark pointer-events-none select-none", className)}>
      <clipPath id={id}>
        <circle cx="32" cy="32" r="32" />
      </clipPath>
      <circle className="m" cx="32" cy="32" r="32" />
      <g clipPath={`url(#${id})`}>
        <circle className="l p" cx="60" cy="60" r="24" />
      </g>
      <circle className="r p" cx="60" cy="60" r="21" />
    </svg>
  );
}

/**
 * The mark assembling itself (the landing "minutes away" band): when it
 * scrolls into view the ring glides in from outside, docks against the disc
 * and the overlap fills: a plan coming together. Then it breathes like the
 * loader, slowly. Reduced motion: the finished mark.
 */
export function BehestAssemble({ className }: { className?: string }) {
  const id = useId();
  const [inView, setInView] = useState(false);
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  useEffect(() => {
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setInView(true);
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setInView(true), io.disconnect()), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return (
    <svg ref={setEl} viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-in={inView || undefined} className={cx("behest-assemble pointer-events-none select-none", className)}>
      <clipPath id={id}>
        <circle cx="32" cy="32" r="32" />
      </clipPath>
      <circle className="m" cx="32" cy="32" r="32" />
      <g clipPath={`url(#${id})`}>
        <circle className="l p" cx="60" cy="60" r="24" />
      </g>
      <circle className="r p" cx="60" cy="60" r="21" />
    </svg>
  );
}
