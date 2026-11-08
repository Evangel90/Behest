import { describe, expect, it } from "vitest";
import { actionsFor, assetLabel, btcSplit, formatBtc, looksLikeBtcAddress, describeOptions, failureText, describePlan, duration, formatAmount, formatEth, formatNear, nextHolder, parseNear, registerTokens, rolesOf, shortName, validateDraft, vaultSplit } from "../src/lib/plan";
import type { PlanInput, PlanView, Transfer } from "../src/lib/types";

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
    const t = { heir: "a", asset: { Erc20: WETH }, destination: "0x", amount: "1", state: "Failed", eth_tx: null, attempts: 1, tx_hash: null, failure: "WouldRevert" } as const;
    expect(failureText(t)).toMatch(/enough WETH.*Retry once the vault is topped up/);
  });
});

describe("release rules", () => {
  const view = {
    plan: { policy: { heirs: [{ account_id: "amara.testnet" }, { account_id: "tobi.testnet" }] }, proposal: { waiting_ends_at_ms: 1_000 } },
  } as unknown as PlanView;
  const kemi = { account_id: "kemi.testnet", near_destination: "kemi.testnet", eth_destination: "0xbb" };
  const ngo = { account_id: "ngo.testnet", near_destination: "ngo.testnet", eth_destination: null };
  const rules = { fixed: [], remainder_to: null, alternates: [{ heir: "amara.testnet", recipient: kemi }], fallback: ngo, claim_window_ms: 60_000 };
  const tr = (heir: string, asset: Transfer["asset"], state = "Pending") => ({ heir, asset, state }) as Transfer;

  it("moves a heir's share to their alternate after one window", () => {
    expect(nextHolder(view, rules, tr("amara.testnet", "Near"))).toEqual({ to: kemi, from_ms: 61_000 });
  });
  it("sends a heir without an alternate straight to the fallback", () => {
    expect(nextHolder(view, rules, tr("tobi.testnet", "Near"))?.to).toBe(ngo);
  });
  it("moves an alternate's share to the fallback one window later", () => {
    expect(nextHolder(view, rules, tr("kemi.testnet", "Near"))).toEqual({ to: ngo, from_ms: 121_000 });
  });
  it("skips recipients without a destination on that chain", () => {
    expect(nextHolder(view, rules, tr("kemi.testnet", "Eth"))).toBeNull();
    expect(nextHolder(view, rules, tr("tobi.testnet", "Eth"))).toBeNull();
  });
  it("never moves a claimed transfer", () => {
    expect(nextHolder(view, rules, tr("amara.testnet", "Near", "Sending"))).toBeNull();
  });
});

describe("release options", () => {
  it("explains the mode and the delay signers' limits", () => {
    expect(describeOptions(null)).toEqual(["Each heir starts their own transfers by claiming."]);
    const o = { mode: "Hybrid" as const, hybrid_grace_ms: 7 * 86_400_000, delay_signers: ["a.testnet", "b.testnet"], delay_quorum: 2, max_extension_ms: 86_400_000, max_total_extension_ms: 3 * 86_400_000 };
    expect(describeOptions(o)).toEqual([
      "Heirs have 7 days after the waiting period to claim; after that, transfers start automatically.",
      "2 of 2 delay signers can extend an approved release's waiting period by up to 1 day at a time, 3 days in total. They can't approve, cancel or move anything.",
    ]);
    expect(describeOptions({ ...o, delay_signers: [], overrides: [{ heir: "tobi.testnet", assets: "Ethereum", mode: "Automatic", hybrid_grace_ms: 0 }] })[1]).toBe("Except: Tobi's Ethereum shares (ETH and tokens) start automatically.");
  });
});

describe("btcSplit (D20)", () => {
  it("matches the contract's reserve: first payout spends the coins, later ones one change output", () => {
    // contract test split_reserves_fees_and_chains_payouts: 2 heirs, 1 coin, cap 5 → 1530 sats
    expect(btcSplit({ heirs: 2, inputs: 1, total: 100_000n, maxFeeRate: 5 })).toEqual({ reserve: 1530n, toSplit: 98_470n });
    expect(btcSplit({ heirs: 1, inputs: 2, total: 100_000n, maxFeeRate: 5 }).reserve).toBe(221n * 5n);
    expect(btcSplit({ heirs: 2, inputs: 1, total: 1_000n, maxFeeRate: 5 })).toMatchObject({ error: "E_INSUFFICIENT_FEE_RESERVE" });
    expect(btcSplit({ heirs: 0, inputs: 1, total: 1_000n, maxFeeRate: 5 }).reserve).toBe(0n);
  });
  it("formats sats and checks testnet addresses", () => {
    expect(formatBtc(59_082)).toBe("0.00059082");
    expect(looksLikeBtcAddress("tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla")).toBe(true);
    expect(looksLikeBtcAddress("bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla")).toBe(false);
  });
});
