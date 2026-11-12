// The plan in plain words, module by module (Check-ins, Activation,
// Guardians, Waiting period, Heirs and allocations, Claims, Recovery), with
// the consequence of each choice and warnings for risky combinations. Pure:
// shown before saving, after every edit, on every plan view, and when a
// release is proposed.
import { duration, listNames, shortName } from "./plan";
import type { GuardianSettings, PlanInput, ReleaseOptions, ReleaseRules } from "./types";

export type SummaryModule = "checkins" | "activation" | "guardians" | "waiting" | "heirs" | "claims" | "recovery";

export const MODULE_LABEL: Record<SummaryModule, string> = {
  checkins: "Check-ins",
  activation: "Activation",
  guardians: "Guardians",
  waiting: "Waiting period",
  heirs: "Heirs and allocations",
  claims: "Claims",
  recovery: "Recovery and safety",
};

export interface SummarySection {
  module: SummaryModule;
  /** What the rule is. */
  rule: string;
  /** What that means in practice. */
  consequence: string;
}

export interface SummaryWarning {
  module: SummaryModule;
  tone: "warn" | "info";
  text: string;
}

export interface SummaryInput {
  plan: PlanInput;
  rules?: ReleaseRules | null;
  options?: ReleaseOptions | null;
  /** D28 edit notice (ms; 0 = off). Undefined: unknown (older contract). */
  notice?: number;
  guardianSettings?: GuardianSettings | null;
  btcDestinations?: number;
  intents?: number;
  delegates?: number;
  /** D30: how many registered destinations are proven, of how many. */
  proofs?: { proven: number; total: number };
  /** Demo builds use minute-scale timers: skip day-based advice. */
  demo?: boolean;
}

const DAY = 86_400_000;

export function planSummary(i: SummaryInput, ownerLabel = "you"): { sections: SummarySection[]; warnings: SummaryWarning[] } {
  const p = i.plan;
  const you = ownerLabel === "you";
  const You = you ? "You" : ownerLabel;
  const your = you ? "your" : `${ownerLabel}'s`;
  const g = p.guardians.length;
  const q = p.quorum;
  const opts = i.options;
  const mode = opts?.mode ?? "Claim";
  const sections: SummarySection[] = [];
  const warnings: SummaryWarning[] = [];
  const warn = (module: SummaryModule, text: string, tone: "warn" | "info" = "warn") => warnings.push({ module, tone, text });

  // Check-ins
  const delegates = i.delegates ?? 0;
  sections.push({
    module: "checkins",
    rule: `${You} check${you ? "" : "s"} in at least every ${duration(p.check_in_interval_ms)}${p.grace_ms > 0 ? `, with ${duration(p.grace_ms)} of grace` : ""}. Saving or editing the plan counts as a check-in.${delegates ? ` ${delegates} delegate${delegates === 1 ? "" : "s"} may also check in for ${you ? "you" : ownerLabel}.` : ""}`,
    consequence: `After ${duration(p.check_in_interval_ms + p.grace_ms)} without one, ${your} plan is overdue. A missed check-in is not proof of anything; it only lets guardians act.`,
  });
  if (!i.demo && p.grace_ms === 0) warn("checkins", "No grace period: a single late check-in makes the plan overdue at once.");

  // Activation
  sections.push({
    module: "activation",
    rule: `Once ${your} plan is overdue, any guardian may propose a release.${q ? ` It needs ${q} of ${g} guardians to approve.` : ""}`,
    consequence: `Nothing moves until ${q || "enough"} guardian${q === 1 ? "" : "s"} agree, and ${you ? "you" : ownerLabel} can still check in to stop it.`,
  });

  // Guardians
  const standbys = i.guardianSettings?.standbys.length ?? 0;
  const avail = i.guardianSettings?.availability_ms ?? 0;
  sections.push({
    module: "guardians",
    rule: g ? `${listNames(p.guardians.map(shortName))} watch over the plan; any ${q} of ${g} can approve.${standbys ? ` ${standbys} standby${standbys === 1 ? "" : "s"} can take an empty or unresponsive seat.` : ""}` : "No guardians yet.",
    consequence: "Guardians can only release the plan exactly as written. They can't change heirs, amounts or addresses, and they never hold funds.",
  });
  if (g > 1 && q === g) warn("guardians", standbys ? `All ${g} guardians must approve: if one is unreachable, a standby has to take their seat first.` : `All ${g} guardians must approve: if any one becomes unreachable and there's no standby, no release can start.`);
  if (q === 1 && g > 1) warn("guardians", `A single guardian can approve a release on their own once ${you ? "you're" : `${ownerLabel} is`} overdue.`);
  if (g > 0 && !avail) warn("guardians", "Availability checks are off: nobody is told if a guardian quietly disappears.", "info");

  // Waiting period
  const ext = opts && opts.delay_signers.length ? ` ${opts.delay_quorum} of ${opts.delay_signers.length} delay signers can extend it, up to ${duration(opts.max_total_extension_ms)} in total.` : "";
  sections.push({
    module: "waiting",
    rule: `After approval, a waiting period of ${duration(p.waiting_period_ms)} runs.${ext}`,
    consequence: `${You} can cancel at any time until it ends. After that the release can't be cancelled.`,
  });
  if (!i.demo && p.waiting_period_ms < 14 * DAY) warn("waiting", `Only ${duration(p.waiting_period_ms)} to cancel a release you didn't expect. 14 days or more gives more room.`, "info");

  // Heirs and allocations
  const r = i.rules;
  const fixed = r?.fixed.length ? ` Fixed amounts come out first (${r.fixed.length}); the rest is split by share${r.remainder_to ? `, any remainder to ${shortName(r.remainder_to)}` : ""}.` : "";
  const shares = p.heirs.map((h) => `${shortName(h.account_id)} ${h.share_bps / 100}%`).join(", ");
  sections.push({
    module: "heirs",
    rule: p.heirs.length ? `${shares}.${fixed}` : "No heirs yet.",
    consequence: `Shares are worked out when a release is proposed, from what's in ${your} plan then. Funds go only to the addresses ${you ? "you" : ownerLabel} registered.`,
  });
  const someEth = p.heirs.some((h) => h.eth_destination);
  const noEth = p.heirs.filter((h) => !h.eth_destination);
  if (someEth && noEth.length) warn("heirs", `${listNames(noEth.map((h) => shortName(h.account_id)))} ${noEth.length === 1 ? "has" : "have"} no Ethereum address, so their ETH share stays in the vault for ${you ? "you" : ownerLabel} to withdraw.`, "info");
  const alternates = r?.alternates.length ?? 0;
  if (p.heirs.length && !alternates && !r?.fallback) warn("heirs", "No alternate or fallback: if an heir can't receive, their share waits for them.", "info");
  if (i.proofs && i.proofs.total > i.proofs.proven) warn("heirs", `${i.proofs.total - i.proofs.proven} of ${i.proofs.total} heir address${i.proofs.total === 1 ? "" : "es"} ${i.proofs.total - i.proofs.proven === 1 ? "isn't" : "aren't"} proven yet. Ask heirs to prove them from their plan page.`, "info");

  // Claims
  const claimLine = {
    Claim: "Each heir claims their own share once the waiting period ends.",
    Automatic: "Shares are sent automatically to the registered addresses once the waiting period ends.",
    Hybrid: `Heirs can claim for ${duration(opts?.hybrid_grace_ms ?? 0)}; then any unclaimed share is sent automatically.`,
  }[mode];
  const window = r?.claim_window_ms ? ` An heir who hasn't claimed within ${duration(r.claim_window_ms)} can be passed to ${alternates ? "their alternate" : r?.fallback ? `the fallback (${shortName(r.fallback.account_id)})` : "nobody (they keep their claim)"}.` : "";
  const via = [i.btcDestinations ? "Bitcoin" : null, i.intents ? "NEAR Intents" : null].filter(Boolean).join(" and ");
  sections.push({
    module: "claims",
    rule: `${claimLine}${(opts?.overrides ?? []).length ? " Some heirs or assets use a different mode." : ""}${window}`,
    consequence: mode === "Automatic" ? "Heirs don't need to do anything, so their addresses must still work." : `Heirs need to act; Behest tells them when it's time${via ? `, including for ${via}` : ""}.`,
  });
  if (mode === "Automatic" && i.proofs && i.proofs.proven < i.proofs.total) warn("claims", "Automatic release sends to addresses nobody has proven. A wrong address can't be undone.");

  // Recovery and safety
  const n = i.notice;
  sections.push({
    module: "recovery",
    rule:
      n === undefined
        ? "Edits apply as soon as they're saved."
        : n > 0
          ? `Changes to heirs, addresses, shares or guardians wait ${duration(n)} before they take effect, and guardians and heirs are told.`
          : "Edits to heirs, addresses, shares and guardians apply as soon as they're saved.",
    consequence: n ? `If someone else gets ${your} key, ${you ? "you have" : `${ownerLabel} has`} ${duration(n)} to notice and cancel. Withdrawals stay instant.` : `Only ${your} account can edit the plan. Keep a way back into it (a second key, a delegate).`,
  });
  if (n === 0) warn("recovery", `No edit notice: someone with ${your} key could change heirs or addresses immediately.`);

  return { sections, warnings };
}
