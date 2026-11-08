import { describe, expect, it } from "vitest";
import { notices, recipients, type PlanView } from "../src/diff.js";

const MIN = 60_000;
function v(status: PlanView["status"], extra: { now?: number; proposal?: PlanView["plan"]["proposal"]; lastCheckIn?: number } = {}): PlanView {
  return {
    status,
    overdue_at_ms: 10 * MIN,
    now_ms: extra.now ?? 0,
    plan: {
      owner: "kemi.testnet",
      last_check_in_ms: extra.lastCheckIn ?? 0,
      policy: { check_in_interval_ms: 10 * MIN, grace_ms: 0, quorum: 2, guardians: ["dayo.testnet", "funmi.testnet"], heirs: [{ account_id: "amara.testnet" }] },
      proposal: extra.proposal ?? null,
      proposals_opened: extra.proposal ? 1 : 0,
    },
  };
}
const proposal = (o: Partial<NonNullable<PlanView["plan"]["proposal"]>> = {}) => ({
  id: 1,
  approvals: ["dayo.testnet"],
  waiting_ends_at_ms: null,
  transfers: [{ heir: "amara.testnet", asset: "Eth", amount: "1", state: "Pending", failure: null, attempts: 0 }],
  ...o,
});
const kinds = (prev: PlanView | null, cur: PlanView) => notices(prev, cur).map((n) => n.kind);

describe("notices", () => {
  it("stays quiet early in the check-in window, then reminds the owner once per check-in", () => {
    expect(kinds(null, v("Active", { now: 5 * MIN }))).toEqual([]);
    const a = notices(null, v("Active", { now: 8 * MIN }));
    expect(a.map((n) => [n.kind, n.to])).toEqual([["reminder", ["owner"]]]);
    // after a new check-in the reminder key changes
    const b = notices(null, v("Active", { now: 18 * MIN, lastCheckIn: 10 * MIN }));
    expect(b[0]?.key).not.toBe(a[0]?.key);
  });

  it("follows the lifecycle with stable keys", () => {
    expect(kinds(null, v("Overdue"))).toEqual(["overdue"]);
    expect(kinds(null, v("Proposed", { proposal: proposal() }))).toEqual(["proposed"]);
    expect(kinds(null, v("Waiting", { proposal: proposal({ waiting_ends_at_ms: 20 * MIN }) }))).toEqual(["proposed", "approved"]);
    const prevW = v("Waiting", { proposal: proposal({ waiting_ends_at_ms: 20 * MIN }) });
    expect(kinds(prevW, v("Waiting", { proposal: proposal({ waiting_ends_at_ms: 30 * MIN }) }))).toEqual(["proposed", "approved", "extended"]);
    expect(kinds(prevW, prevW)).toEqual(["proposed", "approved"]);
    expect(kinds(null, v("Eligible", { proposal: proposal({ waiting_ends_at_ms: 20 * MIN }) }))).toContain("eligible");
    const a = notices(null, v("Proposed", { proposal: proposal(), now: 1 }));
    const b = notices(null, v("Proposed", { proposal: proposal(), now: 999 }));
    expect(a.map((n) => n.key)).toEqual(b.map((n) => n.key));
  });

  it("notices a cancellation, but not a settlement, as the proposal disappearing", () => {
    const waiting = v("Waiting", { proposal: proposal({ waiting_ends_at_ms: 20 * MIN }) });
    expect(kinds(waiting, v("Active"))).toEqual(["cancelled"]);
    const settled = v("Settled", { proposal: proposal({ waiting_ends_at_ms: 20 * MIN }) });
    expect(kinds(settled, v("Settled", { proposal: proposal({ waiting_ends_at_ms: 20 * MIN }) }))).not.toContain("cancelled");
  });

  it("tells heirs about a failed transfer once per attempt", () => {
    const failed = (attempts: number) => v("Executing", { proposal: proposal({ waiting_ends_at_ms: 1, transfers: [{ heir: "amara.testnet", asset: "Eth", amount: "1", state: "Failed", failure: "Stuck", attempts }] }) });
    const one = notices(null, failed(1)).find((n) => n.kind === "transfer_failed")!;
    const again = notices(null, failed(1)).find((n) => n.kind === "transfer_failed")!;
    const two = notices(null, failed(2)).find((n) => n.kind === "transfer_failed")!;
    expect(one.key).toBe(again.key);
    expect(two.key).not.toBe(one.key);
    expect(one.to).toEqual(["heirs"]);
  });

  it("resolves audiences to accounts", () => {
    expect(recipients(v("Overdue"), ["owner", "guardians"])).toEqual(["kemi.testnet", "dayo.testnet", "funmi.testnet"]);
  });
});
