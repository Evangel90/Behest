import { describe, expect, it } from "vitest";
import { actionsFor, assetLabel, describePlan, duration, formatAmount, formatEth, formatNear, parseNear, registerTokens, rolesOf, shortName, validateDraft, vaultSplit } from "../src/lib/plan";
import type { PlanInput, PlanView } from "../src/lib/types";

const DAY = 86_400_000;
const policy: PlanInput = {
  check_in_interval_ms: 90 * DAY,
  grace_ms: 7 * DAY,
  waiting_period_ms: 30 * DAY,
  guardians: ["dayo.testnet", "funmi.testnet", "chidi.testnet"],
  quorum: 2,
  heirs: [
    { account_id: "amara.testnet", share_bps: 6000, near_destination: "amara.testnet", eth_destination: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" },
    { account_id: "tobi.testnet", share_bps: 4000, near_destination: "tobi.testnet", eth_destination: null },
  ],
};

function viewOf(status: PlanView["status"], extra: Partial<PlanView["plan"]> = {}): PlanView {
  return {
    status,
    overdue_at_ms: 0,
    now_ms: 0,
    plan: { owner: "kemi.testnet", version: 1, policy, last_check_in_ms: 0, escrow: "0", eth_next_nonce: 0, proposal: null, proposals_opened: 0, ...extra },
  };
}

describe("plain language", () => {
  it("describes the rule like the design system's review card", () => {
    expect(describePlan(policy)).toBe(
      "If you don't check in for 90 days plus 7 days of grace, any 2 of 3 guardians may propose a release. " +
        "A waiting period of 30 days follows, during which you can cancel. " +
        "Then Amara and Tobi receive their shares at the fixed addresses below. Nobody can change where funds go.",
    );
  });

  it("speaks about the owner in the third person for guardians and heirs", () => {
    expect(describePlan({ ...policy, grace_ms: 0, check_in_interval_ms: 60_000 }, "Kemi")).toMatch(/^If Kemi doesn't check in for 1 minute, any 2 of 3/);
  });

  it("formats durations at demo and production scale", () => {
    expect([duration(60_000), duration(120_000), duration(DAY), duration(3 * 3_600_000), duration(0)]).toEqual(["1 minute", "2 minutes", "1 day", "3 hours", "no time"]);
  });

  it("names persona accounts by their role", () => {
    expect([shortName("x7f2-amara.demo.behest-ekkr6-admin.testnet"), shortName("tobi.testnet")]).toEqual(["Amara", "Tobi"]);
  });
});

describe("roles and actions", () => {
  it("finds every role an account holds", () => {
    expect(rolesOf(viewOf("Active"), "kemi.testnet")).toEqual(["owner"]);
    expect(rolesOf(viewOf("Active"), "funmi.testnet")).toEqual(["guardian"]);
    expect(rolesOf(viewOf("Active"), "amara.testnet")).toEqual(["heir"]);
    expect(rolesOf(viewOf("Active"), "stranger.testnet")).toEqual([]);
  });

  it("only lets guardians propose once the owner is unreachable", () => {
    expect(actionsFor(viewOf("Active"), "guardian").can).toEqual([]);
    expect(actionsFor(viewOf("Overdue"), "guardian").can).toEqual(["Propose a release"]);
  });

  it("tells the owner they can cancel during the waiting period but not after", () => {
    expect(actionsFor(viewOf("Waiting"), "owner").can).toContain("Cancel the release");
    expect(actionsFor(viewOf("Eligible"), "owner").can).toEqual([]);
  });

  it("stops a guardian from voting twice", () => {
    const proposal = { id: 1, plan_version: 1, proposer: "dayo.testnet", created_at_ms: 0, approvals: ["dayo.testnet"], rejections: [], approved_at_ms: null, waiting_ends_at_ms: null, near_snapshot: "0", eth_snapshot: "0", eth_fee_reserve: "0", eth_gas_limit: 250000, transfers: [] };
    const v = viewOf("Proposed", { proposal });
    expect(actionsFor(v, "guardian", "dayo.testnet").can).toEqual([]);
    expect(actionsFor(v, "guardian", "funmi.testnet").can).toEqual(["Approve or reject this exact proposal"]);
  });
});

describe("validation", () => {
  it("accepts a valid plan", () => expect(validateDraft(policy, "kemi.testnet")).toEqual([]));
  it("catches the contract's rules before signing", () => {
    const bad: PlanInput = { ...policy, quorum: 4, guardians: [...policy.guardians, "amara.testnet"], heirs: [{ ...policy.heirs[0]!, share_bps: 5000, eth_destination: "0x123" }] };
    expect(validateDraft(bad, "kemi.testnet")).toEqual([
      "Shares add up to 50%; they must add up to 100%.",
      "Amara's Ethereum address isn't valid.",
      "Amara can't be both an heir and a guardian.",
    ]);
  });
});

describe("amounts", () => {
  it("formats and parses without floating point", () => {
    expect(formatNear("1500000000000000000000000")).toBe("1.5");
    expect(formatEth("3160000000000000")).toBe("0.00316");
    expect(parseNear("0.3")).toBe(300_000_000_000_000_000_000_000n);
    expect(() => parseNear("1e3")).toThrow();
  });
});

describe("ERC-20 support", () => {
  const WETH = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";
  const GWEI = 1_000_000_000n;
  const PER_TX = 21_000n * 50n * GWEI;
  const base = { ethHeirs: 1, gasLimit: 21_000, feeCap: 50n * GWEI };

  it("matches the contract's fee-reserve split", () => {
    // mirrors token_snapshot_reserves_a_fee_for_every_vault_transaction
    expect(vaultSplit({ ...base, ethBalance: 10n ** 24n, tokenBalances: [1000n] })).toEqual({ reserve: 2n * PER_TX, ethToSplit: 10n ** 24n - 2n * PER_TX, transfers: 2 });
    // token-only vault: gas money for the token transfer, nothing more
    expect(vaultSplit({ ...base, ethBalance: PER_TX, tokenBalances: [1000n] })).toEqual({ reserve: PER_TX, ethToSplit: 0n, transfers: 1 });
    expect(vaultSplit({ ...base, ethBalance: PER_TX - 1n, tokenBalances: [1000n] }).error).toBe("E_INSUFFICIENT_FEE_RESERVE");
    // ETH only, below the reserve (eth_balance_below_fee_reserve_is_rejected)
    expect(vaultSplit({ ...base, ethBalance: PER_TX, tokenBalances: [] }).error).toBe("E_INSUFFICIENT_FEE_RESERVE");
    // empty balances are ignored
    expect(vaultSplit({ ...base, ethBalance: 0n, tokenBalances: [0n] })).toEqual({ reserve: 0n, ethToSplit: 0n, transfers: 0 });
  });

  it("formats token amounts with the allowlist's symbol and decimals", () => {
    registerTokens([{ address: WETH, symbol: "WETH", decimals: 18 }]);
    expect(assetLabel({ Erc20: WETH })).toBe("WETH");
    expect(formatAmount({ asset: { Erc20: WETH.toUpperCase().replace("0X", "0x") }, amount: "3000000000000000" })).toBe("0.003 WETH");
    expect(formatAmount({ asset: "Eth", amount: "2000000000000000" })).toBe("0.002 ETH");
  });
});
