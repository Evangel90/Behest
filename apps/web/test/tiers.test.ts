import { describe, expect, it } from "vitest";
import { features, formatUsd, payable, reasonFor, requiredTier, tierPerks, type TierConfig } from "../src/lib/tiers";
import type { PlanInput, ReleaseOptions, ReleaseRules } from "../src/lib/types";

// The contract's default schedule (tiers::default_tiers(6)).
const cfg: TierConfig = {
  fee_token: "usdc.testnet",
  fee_symbol: "USDC",
  fee_decimals: 6,
  tiers: [
    { name: "Free", price: "0", max_heirs: 1, max_guardians: 3, external_assets: false, release_rules: false, advanced_release: false },
    { name: "Standard", price: "49000000", max_heirs: 5, max_guardians: 5, external_assets: true, release_rules: true, advanced_release: false },
    { name: "Complete", price: "149000000", max_heirs: 10, max_guardians: 10, external_assets: true, release_rules: true, advanced_release: true },
  ],
};

const heir = (a: string, bps: number, eth: string | null = null) => ({ account_id: a, share_bps: bps, near_destination: a, eth_destination: eth });
const free: PlanInput = { check_in_interval_ms: 1, grace_ms: 1, waiting_period_ms: 1, guardians: ["g1", "g2", "g3"], quorum: 2, heirs: [heir("amara", 10_000)] };
const two: PlanInput = { ...free, heirs: [heir("amara", 6000, "0x71c7656ec7ab88b098defb751b7401b5f6d8976f"), heir("tobi", 4000)] };
const rules: ReleaseRules = { fixed: [], remainder_to: null, alternates: [], fallback: null, claim_window_ms: 1 } as unknown as ReleaseRules;
const claim = { mode: "Claim", hybrid_grace_ms: 0, delay_signers: [], delay_quorum: 0, max_extension_ms: 0, max_total_extension_ms: 0, overrides: [] } as unknown as ReleaseOptions;
const auto = { ...claim, mode: "Automatic" } as unknown as ReleaseOptions;

describe("tiers (mirror of the contract's required_tier)", () => {
  it("matches the contract's cases", () => {
    expect(requiredTier(cfg, features(free, null, null, 0, false))).toBe(0);
    expect(requiredTier(cfg, features(free, null, null, 1, false))).toBe(1);
    expect(requiredTier(cfg, features(free, null, null, 0, true))).toBe(1);
    expect(requiredTier(cfg, features(two, rules, null, 0, false))).toBe(1);
    expect(requiredTier(cfg, features(free, null, claim, 0, false))).toBe(0);
    expect(requiredTier(cfg, features(free, null, auto, 0, false))).toBe(2);
    const big = { ...two, guardians: ["a", "b", "c", "d", "e", "f", "g"] };
    expect(requiredTier(cfg, features(big, null, null, 0, false))).toBe(2);
  });

  it("explains what pushes a plan up", () => {
    expect(reasonFor(cfg, 0, features(two, null, null, 0, false))).toMatch(/2 heirs/);
    expect(reasonFor(cfg, 1, features(free, null, auto, 0, false))).toMatch(/automatic/);
    expect(reasonFor(cfg, 1, features(free, null, null, 0, false))).toBeNull();
  });

  it("formats prices and the first-payment minimum", () => {
    expect(formatUsd("0")).toBe("Free");
    expect(formatUsd("49000000")).toBe("$49");
    expect(formatUsd("49500000")).toBe("$49.50");
    expect(payable(cfg, 500_000n, 0n)).toBe(1_000_000n);
    expect(payable(cfg, 500_000n, 49_000_000n)).toBe(500_000n);
    expect(tierPerks(cfg.tiers[0]!)).toContain("NEAR only");
  });
});
