"use client";
// The plan in plain words (lib/summary.ts): every module's rule and its
// consequence, with warnings for risky combinations.
import { BookOpenText, CircleAlert, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useConfig } from "@/lib/fees";
import { MODULE_LABEL, planSummary, type SummaryInput } from "@/lib/summary";
import { shortName } from "@/lib/plan";
import { getBtcDestinations } from "@/lib/contract";
import { getDelegates } from "./Dao";
import { Disclosure } from "./interactive";
import type { PlanCtx } from "./plan/common";
import { cx } from "./ui";

export function SummaryList({ input, ownerLabel = "you", compact }: { input: SummaryInput; ownerLabel?: string; compact?: boolean }) {
  const { sections, warnings } = planSummary(input, ownerLabel);
  return (
    <div className="flex flex-col gap-4">
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Things to know">
          {warnings.map((w) => (
            <li key={w.text} className={cx("flex items-start gap-2 rounded-row px-3 py-2 text-sm", w.tone === "warn" ? "bg-[var(--s-overdue-bg)] text-[var(--s-overdue-fg)]" : "bg-subtle")}>
              {w.tone === "warn" ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />}
              <span>
                <span className="font-semibold">{MODULE_LABEL[w.module]}: </span>
                {w.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      <dl className="flex flex-col divide-y divide-line">
        {sections.map((s) => (
          <div key={s.module} className={cx("grid gap-1 py-3 first:pt-0 last:pb-0", !compact && "sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4")}>
            <dt className="text-sm font-semibold">{MODULE_LABEL[s.module]}</dt>
            <dd className="flex flex-col gap-1 text-[15px] leading-relaxed">
              <span>{s.rule}</span>
              <span className="text-sm text-muted">{s.consequence}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** On every plan view; opened by default while a release is proposed. */
export function PlanSummaryCard({ ctx, role }: { ctx: PlanCtx; role: "owner" | "guardian" | "heir" | "public" }) {
  const { view, rules, options, recovery, destinations } = ctx;
  const owner = view.plan.owner;
  const demo = !!useConfig()?.demo_timers;
  const [extra, setExtra] = useState<{ btc: number; delegates: number }>({ btc: 0, delegates: 0 });
  useEffect(() => {
    void Promise.all([getBtcDestinations(owner).catch(() => []), getDelegates(owner)]).then(([b, dl]) => setExtra({ btc: b.length, delegates: dl.length }));
  }, [owner, view.plan.version]);
  const proofs = destinations.supported && destinations.current.length ? { proven: destinations.current.filter((d) => d.proven_at_ms).length, total: destinations.current.length } : undefined;
  const input: SummaryInput = {
    plan: view.plan.policy,
    rules: rules.rules ?? null,
    options: options.options ?? null,
    notice: recovery.supported ? recovery.notice : undefined,
    guardianSettings: recovery.settings,
    btcDestinations: extra.btc,
    delegates: extra.delegates,
    proofs,
    demo,
  };
  const proposed = !!view.plan.proposal && view.status !== "Settled";
  return (
    <Disclosure
      key={proposed ? "proposed" : "idle"}
      icon={BookOpenText}
      title="The plan in plain words"
      sub={proposed ? "A release is under way: this is exactly what it follows." : role === "owner" ? "What each setting means, and what to watch out for" : `What ${shortName(owner)}'s plan does, step by step`}
      defaultOpen={proposed}
    >
      <SummaryList input={input} ownerLabel={role === "owner" ? "you" : shortName(owner)} />
    </Disclosure>
  );
}
