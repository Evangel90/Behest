import { relative } from "@/lib/plan";

/** Check-in pulse: concentric rings (one per check-in look), the blue arc is the time left. */
export function Pulse({ overdueAt, period, now, overdue }: { overdueAt: number; period: number; now: number; overdue: boolean }) {
  const left = Math.max(0, overdueAt - now);
  const frac = period > 0 ? Math.min(1, left / period) : 0;
  const C = 2 * Math.PI * 104;
  const rings = 14;
  const big = overdue ? "Late" : left > 86_400_000 ? `${Math.ceil(left / 86_400_000)}d` : left > 3_600_000 ? `${Math.ceil(left / 3_600_000)}h` : left > 60_000 ? `${Math.ceil(left / 60_000)}m` : `${Math.ceil(left / 1000)}s`;
  return (
    <div className="relative h-[240px] w-[240px]">
      <svg width="240" height="240" viewBox="0 0 240 240" fill="none" role="img" aria-label={overdue ? "Check-in overdue" : `Next check-in due ${relative(overdueAt, now)}`}>
        {Array.from({ length: rings }, (_, i) => (
          <circle key={i} cx="120" cy="120" r={12 + i * 6.4} stroke="#FFFFFF" strokeOpacity={(0.05 + (i / rings) * 0.2).toFixed(2)} strokeWidth="1" />
        ))}
        <circle cx="120" cy="120" r="104" stroke="#2E2E2E" strokeWidth="8" />
        <circle
          cx="120"
          cy="120"
          r="104"
          stroke={overdue ? "#F59E0B" : "#2F6BFF"}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(C * (overdue ? 1 : frac)).toFixed(1)} ${C.toFixed(1)}`}
          transform="rotate(-90 120 120)"
          className="transition-[stroke-dasharray] duration-[480ms] ease-ledger"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
        <span className="text-[56px] font-medium leading-none tracking-[-0.04em] text-white">{big}</span>
        <span className="text-[13px] text-muted-dark">{overdue ? "check in now" : "until check-in"}</span>
      </div>
    </div>
  );
}
