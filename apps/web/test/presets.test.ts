import { describe, expect, it } from "vitest";
import { PRESETS, applyPreset, editedFrom, presetValues } from "../src/lib/presets";
import { planSummary } from "../src/lib/summary";
import { timingErrors, toMs } from "../src/lib/wizard";
import type { PlanInput } from "../src/lib/types";

const DAY = 86_400_000;
const draft = { checkIn: { n: "5", unit: "minutes" as const }, grace: { n: "0", unit: "minutes" as const }, waiting: { n: "5", unit: "minutes" as const }, guardians: ["a.testnet"], quorum: "1", notice: 0, availability: 0, swapDelay: 0 };

describe("presets", () => {
  it("every preset passes the wizard's timing rules and stays within the Free tier", () => {
    for (const p of PRESETS)
      for (const demo of [true, false]) {
        const d = applyPreset(draft, p.id, demo);
        expect(timingErrors(d, demo)).toEqual({});
        expect(Number(d.quorum)).toBeLessThan(d.guardians.length + 1);
        expect(d.guardians.length).toBeLessThanOrEqual(3);
        const v = presetValues(p.id, demo);
        if (!demo) {
          expect(v.notice === 0 || (v.notice >= DAY && v.notice <= 90 * DAY)).toBe(true);
          expect(v.availability === 0 || (v.availability >= 30 * DAY && v.availability <= 365 * DAY)).toBe(true);
          expect(v.swapDelay >= DAY && v.swapDelay <= 90 * DAY).toBe(true);
        }
      }
  });
  it("keeps guardians already typed and reports what was edited", () => {
    const d = applyPreset(draft, "balanced", false);
    expect(d.guardians).toEqual(["a.testnet", "", ""]);
    const v = { checkIn: toMs(d.checkIn), grace: toMs(d.grace), waiting: toMs(d.waiting), guardians: 3, quorum: 2, notice: d.notice, availability: d.availability, swapDelay: d.swapDelay };
    expect(editedFrom(v, "balanced", false)).toEqual([]);
    expect(editedFrom({ ...v, waiting: 30 * DAY }, "balanced", false)).toEqual(["waiting"]);
  });
});

describe("plain-language summary", () => {
  const plan: PlanInput = { check_in_interval_ms: 90 * DAY, grace_ms: 7 * DAY, waiting_period_ms: 7 * DAY, guardians: ["g1.testnet", "g2.testnet"], quorum: 2, heirs: [{ account_id: "amara.testnet", share_bps: 10_000, near_destination: "amara.testnet", eth_destination: null }] };
  it("covers every module and flags risky combinations", () => {
    const { sections, warnings } = planSummary({ plan, notice: 0 });
    expect(sections.map((s) => s.module)).toEqual(["checkins", "activation", "guardians", "waiting", "heirs", "claims", "recovery"]);
    const w = warnings.map((x) => x.text).join("\n");
    expect(w).toMatch(/All 2 guardians must approve/);
    expect(w).toMatch(/No edit notice/);
    expect(w).toMatch(/Only 7 days to cancel/);
  });
  it("speaks about the owner by name for others, and quiets warnings that don't apply", () => {
    const { sections, warnings } = planSummary({ plan: { ...plan, guardians: [...plan.guardians, "g3.testnet"], waiting_period_ms: 30 * DAY }, notice: 7 * DAY, guardianSettings: { standbys: [], availability_ms: 90 * DAY, swap_delay_ms: 7 * DAY }, rules: { fixed: [], remainder_to: null, alternates: [], fallback: { account_id: "f.testnet", near_destination: null, eth_destination: null }, claim_window_ms: 0 } }, "Kemi");
    expect(sections[0]!.rule).toMatch(/^Kemi checks in/);
    expect(sections.at(-1)!.rule).toMatch(/wait 7 days/);
    expect(warnings.filter((x) => x.tone === "warn")).toEqual([]);
  });
  it("warns when automatic release would send to unproven addresses", () => {
    const { warnings } = planSummary({ plan, notice: DAY, options: { mode: "Automatic", hybrid_grace_ms: 0, delay_signers: [], delay_quorum: 0, max_extension_ms: 0, max_total_extension_ms: 0 }, proofs: { proven: 0, total: 1 } });
    expect(warnings.some((x) => /unproven|nobody has proven/.test(x.text))).toBe(true);
  });
});
