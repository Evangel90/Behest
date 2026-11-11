import { describe, expect, it } from "vitest";
import { CONTRACT_ID } from "../src/lib/config";
import { checkInAdvice, concerns, councilOf, describeDaoCall, isOpen, powers, proposalArgs, rolesOf, unb64, voteRule, type DaoPolicy, type DaoProposal } from "../src/lib/dao";
import { allows, features, reasonFor, tierPerks, type TierSpec } from "../src/lib/tiers";

const DAY = 86_400_000;
const NS = 1_000_000n;
const DAO = "family.sputnikv2.testnet";

// sputnikv2.testnet's default policy for a two-member council, as get_policy returns it.
const policy: DaoPolicy = {
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: ["kemi.testnet", "dayo.testnet"] }, permissions: ["*:Finalize", "*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: "100000000000000000000000",
  proposal_period: (7n * BigInt(DAY) * NS).toString(),
};

describe("DAO proposals (D26)", () => {
  it("reads roles, powers and the vote rule from get_policy", () => {
    expect(rolesOf(policy, "kemi.testnet").map((r) => r.name)).toEqual(["all", "council"]);
    expect(powers(policy, "kemi.testnet")).toEqual({ propose: true, approve: true, reject: true });
    expect(powers(policy, "stranger.testnet")).toEqual({ propose: true, approve: false, reject: false });
    expect(councilOf(policy)).toEqual(["dayo.testnet", "kemi.testnet"]);
    // Sputnik needs more than half of 2: both.
    expect(voteRule(policy)).toBe("2 of 2 council votes");
    const three = { ...policy, roles: [policy.roles[0]!, { ...policy.roles[1]!, kind: { Group: ["a.testnet", "b.testnet", "c.testnet"] } }] };
    expect(voteRule(three)).toBe("2 of 3 council votes");
  });

  it("wraps a Behest call in add_proposal with base64 args, the deposit and bounded gas", () => {
    const a = proposalArgs(DAO, [{ method: "set_plan", args: { plan: { quorum: 1 } }, deposit: 10n ** 23n, tgas: 250 }]);
    const fc = a.proposal.kind.FunctionCall;
    expect(fc.receiver_id).toBe(CONTRACT_ID);
    expect(fc.actions[0]).toMatchObject({ method_name: "set_plan", deposit: "100000000000000000000000", gas: "150000000000000" });
    expect(unb64(fc.actions[0]!.args)).toEqual({ plan: { quorum: 1 } });
    expect(a.proposal.description).toBe("Save the DAO's inheritance plan · via Behest");
  });

  it("puts several calls in one proposal, but only to one contract", () => {
    const a = proposalArgs(DAO, [
      { method: "set_plan", args: { plan: {} }, deposit: 1n },
      { method: "deposit", args: { owner: DAO }, deposit: 5n },
    ]);
    expect(a.proposal.kind.FunctionCall.actions.map((x) => x.method_name)).toEqual(["set_plan", "deposit"]);
    expect(() => proposalArgs(DAO, [{ method: "a", args: {} }, { method: "b", args: {}, receiverId: "usdc.testnet" }])).toThrow("one contract");
    expect(() => proposalArgs(DAO, [])).toThrow();
  });

  it("describes calls to other contracts: the DAO pays its tier with ft_transfer_call", () => {
    const pay = { method: "ft_transfer_call", args: { receiver_id: CONTRACT_ID, amount: "49000000", msg: JSON.stringify({ pay_tier: DAO }) }, deposit: 1n, receiverId: "usdc.testnet" };
    expect(describeDaoCall(DAO, pay, "usdc.testnet")).toBe("Pay the Behest plan tier for this DAO (49 USDC)");
    const a = proposalArgs(DAO, [pay], undefined, "usdc.testnet");
    expect(a.proposal.kind.FunctionCall).toMatchObject({ receiver_id: "usdc.testnet", actions: [{ method_name: "ft_transfer_call", deposit: "1" }] });
    expect(describeDaoCall(DAO, { method: "approve_release", args: { owner: "kemi.testnet", proposal_id: 3 } })).toBe("Approve release #3 of Kemi's plan");
    expect(describeDaoCall(DAO, { method: "check_in", args: {} })).toBe("Check in on the DAO's plan");
  });

  it("finds the DAO's proposals about a plan, and which are still open", () => {
    const mk = (id: number, receiver: string, args: Record<string, unknown>, status: DaoProposal["status"] = "InProgress", ageDays = 1): DaoProposal => ({
      id,
      proposer: "kemi.testnet",
      description: "x",
      kind: { FunctionCall: { receiver_id: receiver, actions: [{ method_name: "m", args: btoa(JSON.stringify(args)), deposit: "0", gas: "1" }] } },
      status,
      vote_counts: {},
      votes: {},
      submission_time: (BigInt(Date.now() - ageDays * DAY) * NS).toString(),
    });
    expect(concerns(mk(1, CONTRACT_ID, { plan: {} }), DAO, DAO)).toBe(true); // own plan
    expect(concerns(mk(2, CONTRACT_ID, { owner: "kemi.testnet" }), DAO, "kemi.testnet")).toBe(true); // guarding kemi's
    expect(concerns(mk(3, CONTRACT_ID, { owner: "kemi.testnet" }), DAO, DAO)).toBe(false);
    expect(concerns(mk(4, "usdc.testnet", { msg: JSON.stringify({ pay_tier: DAO }) }), DAO, DAO, "usdc.testnet")).toBe(true);
    expect(concerns(mk(5, "other.testnet", {}), DAO, DAO)).toBe(false);
    expect(isOpen(mk(6, CONTRACT_ID, {}), policy)).toBe(true);
    expect(isOpen(mk(7, CONTRACT_ID, {}, "InProgress", 8), policy)).toBe(false); // past the 7-day window
    expect(isOpen(mk(8, CONTRACT_ID, {}, "Approved"), policy)).toBe(false);
  });

  it("warns when the check-in interval is near the proposal period", () => {
    expect(checkInAdvice(5 * DAY, policy)).toBe("too_short");
    expect(checkInAdvice(14 * DAY, policy)).toBe("tight");
    expect(checkInAdvice(90 * DAY, policy)).toBe("ok");
  });

  it("makes check-in delegates a Standard feature, and reads older schedules", () => {
    const free: TierSpec = { name: "Free", price: "0", max_heirs: 1, max_guardians: 3, external_assets: false, release_rules: false, advanced_release: false, checkin_delegates: false };
    const std: TierSpec = { name: "Standard", price: "49000000", max_heirs: 5, max_guardians: 5, external_assets: true, release_rules: true, advanced_release: false };
    const f = features({ heirs: [{ account_id: "a", share_bps: 10000, near_destination: null, eth_destination: null }], guardians: ["g"] }, null, null, 0, false, 2);
    expect(f.checkin_delegates).toBe(true);
    expect(allows(free, f)).toBe(false);
    expect(allows(std, f)).toBe(true); // no field: follows release_rules
    expect(reasonFor({ fee_token: "u", fee_symbol: "USDC", fee_decimals: 6, tiers: [free, std] }, 0, f)).toBe("check-in delegates");
    expect(tierPerks(std)).toContain("Check-in delegates (for DAOs and busy owners)");
  });
});
