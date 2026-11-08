import { relative } from "@/lib/plan";

/** Check-in pulse: the arc is the time left before the owner counts as unreachable. */
export function Pulse({ overdueAt, period, now, overdue }: { overdueAt: number; period: number; now: number; overdue: boolean }) {
  const left = Math.max(0, overdueAt - now);
  const frac = period > 0 ? Math.min(1, left / period) : 0;
  const C = 2 * Math.PI * 110;
  const rings = 12;
  const big = overdue ? "Late" : left > 86_400_000 ? `${Math.ceil(left / 86_400_000)}d` : left > 3_600_000 ? `${Math.ceil(left / 3_600_000)}h` : left > 60_000 ? `${Math.ceil(left / 60_000)}m` : `${Math.ceil(left / 1000)}s`;
  return (
    <div className="relative h-[240px] w-[240px]">
      <svg width="240" height="240" viewBox="0 0 240 240" fill="none" role="img" aria-label={overdue ? "Check-in overdue" : `Next check-in due ${relative(overdueAt, now)}`}>
        {Array.from({ length: rings }, (_, i) => (
          <circle key={i} cx="120" cy="120" r={14 + i * 7.4} stroke="#F4F3EE" strokeOpacity={(0.06 + (i / rings) * 0.24).toFixed(2)} strokeWidth="1" />
        ))}
        <circle cx="120" cy="120" r="110" stroke="#1F1F1F" strokeWidth="8" />
        <circle
          cx="120"
          cy="120"
          r="110"
          stroke={overdue ? "#FFB224" : "#00E59B"}
          strokeWidth="8"
          strokeDasharray={`${(C * (overdue ? 1 : frac)).toFixed(1)} ${C.toFixed(1)}`}
          transform="rotate(-90 120 120)"
          className="transition-[stroke-dasharray] duration-[480ms] ease-ledger"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-[64px] font-bold leading-[0.9] tracking-[-0.05em]">{big}</span>
        <span className="font-mono text-xs uppercase text-muted-dark">{overdue ? "check in now" : "to check in"}</span>
      </div>
    </div>
  );
}
