import { describe, expect, it } from "vitest";
import { formatAmount, notices, recipients, type Notice, type PlanView, type Proposal, type Snapshot, type Transfer } from "../src/diff.js";

const MIN = 60_000;
type Extra = { now?: number; proposal?: Proposal | null; lastCheckIn?: number; history?: Snapshot["history"]; extension?: Snapshot["extension"]; options?: Snapshot["options"]; withdrawal?: Transfer | null };
function s(status: PlanView["status"], x: Extra = {}): Snapshot {
  return {
    view: {
      status,
      overdue_at_ms: (x.lastCheckIn ?? 0) + 10 * MIN,
      now_ms: x.now ?? 0,
      plan: {
        owner: "kemi.testnet",
        last_check_in_ms: x.lastCheckIn ?? 0,
        policy: { check_in_interval_ms: 10 * MIN, grace_ms: 0, quorum: 2, guardians: ["dayo.testnet", "funmi.testnet", "chidi.testnet"], heirs: [{ account_id: "amara.testnet" }, { account_id: "tobi.testnet" }] },
        proposal: x.proposal ?? null,
        proposals_opened: x.proposal ? 1 : 0,
      },
    },
    history: x.history ?? (x.proposal ? [] : undefined),
    extension: x.extension,
    options: x.options,
    withdrawal: x.withdrawal,
  };
}
const tr = (o: Partial<Transfer> = {}): Transfer => ({ heir: "amara.testnet", asset: "Eth", destination: "0xabc", amount: "1000000000000000000", state: "Pending", failure: null, attempts: 0, tx_hash: null, ...o });
const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: 1,
  proposer: "dayo.testnet",
  created_at_ms: 11 * MIN,
  approvals: ["dayo.testnet"],
  rejections: [],
  waiting_ends_at_ms: null,
  transfers: [tr()],
  ...o,
});
const kinds = (prev: Snapshot | null, cur: Snapshot) => notices(prev, cur).map((n) => n.kind);
const find = (ns: Notice[], kind: Notice["kind"]) => ns.find((n) => n.kind === kind)!;
const waiting = (o: Partial<Proposal> = {}) => proposal({ approvals: ["dayo.testnet", "funmi.testnet"], waiting_ends_at_ms: 20 * MIN, ...o });

describe("check-ins", () => {
  it("stays quiet early, reminds at 75% and again at 95%, once per check-in", () => {
    expect(kinds(null, s("Active", { now: 5 * MIN }))).toEqual([]);
    const a = notices(null, s("Active", { now: 8 * MIN }));
    expect(a.map((n) => [n.kind, n.to])).toEqual([["reminder", ["owner"]]]);
    const late = notices(null, s("Active", { now: 9.6 * MIN }));
    expect(late.map((n) => n.key)).toEqual(["kemi.testnet:reminder:0", "kemi.testnet:reminder2:0"]);
    const b = notices(null, s("Active", { now: 18 * MIN, lastCheckIn: 10 * MIN }));
    expect(b[0]?.key).not.toBe(a[0]?.key);
  });

  it("tells owner and guardians when the owner is overdue, without saying more than it knows", () => {
    const [n] = notices(null, s("Overdue", { now: 11 * MIN }));
    expect(n?.kind).toBe("overdue");
    expect(recipients(s("Overdue"), n!)).toEqual(["kemi.testnet", "dayo.testnet", "funmi.testnet", "chidi.testnet"]);
    expect(n?.text).toContain("unreachable");
  });
});

describe("release lifecycle", () => {
  it("follows proposal → votes → approval → eligibility with stable keys", () => {
    const proposed = notices(null, s("Proposed", { proposal: proposal() }));
    expect(proposed.map((n) => n.kind)).toEqual(["proposed"]);
    // the proposer isn't told about their own proposal
    expect(recipients(s("Proposed"), proposed[0]!)).toEqual(["kemi.testnet", "funmi.testnet", "chidi.testnet"]);
    // first seen already approved: the approval, not a stale "proposed"
    expect(kinds(null, s("Waiting", { proposal: waiting() }))).toEqual(["approved"]);
    // first seen once the waiting period is over: only what is still true
    expect(kinds(null, s("Eligible", { proposal: waiting() }))).toEqual(["eligible"]);
    const a = notices(null, s("Proposed", { proposal: proposal(), now: 1 }));
    const b = notices(null, s("Proposed", { proposal: proposal(), now: 999 }));
    expect(a.map((n) => n.key)).toEqual(b.map((n) => n.key));
  });

  it("reports each guardian vote before the quorum, not to the voter", () => {
    const ns = notices(null, s("Proposed", { proposal: proposal({ approvals: ["dayo.testnet"], rejections: ["chidi.testnet"] }) }));
    const votes = ns.filter((n) => n.kind === "vote");
    expect(votes.map((n) => n.key)).toEqual(["kemi.testnet:vote:1:chidi.testnet"]); // the proposer's own approval is the proposal
    expect(votes[0]!.subject).toContain("rejected");
    expect(recipients(s("Proposed"), votes[0]!)).not.toContain("chidi.testnet");
    const two = notices(null, s("Proposed", { proposal: proposal({ proposer: "tobi.testnet", approvals: ["dayo.testnet"] }) }));
    expect(find(two, "vote").text).toContain("1 of 2");
  });

  it("tells settled, cancelled and rejected apart when a proposal disappears", () => {
    const open = s("Waiting", { proposal: waiting() });
    // archived into history: settled
    expect(kinds(open, s("Active", { history: [{ id: 1, created_at_ms: 11 * MIN }], lastCheckIn: 0 }))).toEqual(["settled"]);
    // owner cancelled (cancel and check-in both record a check-in)
    const cancelled = notices(open, s("Active", { history: [], lastCheckIn: 15 * MIN, now: 15 * MIN }));
    expect(cancelled.map((n) => n.kind)).toEqual(["cancelled"]);
    expect(cancelled[0]!.to).toEqual(["guardians", "heirs", "delay_signers"]);
    // unapproved and no check-in: guardians rejected it
    const proposed = s("Proposed", { proposal: proposal() });
    const rejected = notices(proposed, s("Overdue", { history: [], now: 12 * MIN }));
    expect(rejected.map((n) => n.kind)).toEqual(["overdue", "rejected"]);
    // an unapproved proposal the owner cancelled only concerned the guardians
    expect(find(notices(proposed, s("Active", { history: [], lastCheckIn: 12 * MIN, now: 12 * MIN })), "cancelled").to).toEqual(["guardians"]);
    // without the history the notifier doesn't guess
    expect(kinds(open, { ...s("Active"), history: undefined })).toEqual([]);
    // the settled notice shares its key with the one sent while the release sat settled
    const settledOpen = notices(null, s("Settled", { proposal: waiting({ transfers: [tr({ state: "Confirmed" })] }) }));
    expect(find(settledOpen, "settled").key).toBe("kemi.testnet:settled:1");
  });

  it("includes heirs in a follow-up round (D21)", () => {
    const followUp = s("Proposed", { proposal: proposal({ id: 2, proposer: "amara.testnet", approvals: [] }), history: [{ id: 1, created_at_ms: 11 * MIN }] });
    const n = find(notices(null, followUp), "proposed");
    expect(n.subject).toContain("Follow-up");
    expect(n.to).toContain("heirs");
    expect(recipients(followUp, n)).not.toContain("amara.testnet");
  });
});

describe("delay signers (D18)", () => {
  const options = { mode: "Claim" as const, delay_signers: ["sade.testnet", "bayo.testnet"], delay_quorum: 2 };
  it("tells the owner and other delay signers about a request, and everyone about an extension", () => {
    const req = s("Waiting", { proposal: waiting(), options, extension: { proposal_id: 1, total_ms: 0, count: 0, pending: { extension_ms: 60 * MIN, reason: "travel", votes: ["sade.testnet"] } } });
    const n = find(notices(null, req), "extension_requested");
    expect(recipients(req, n)).toEqual(["kemi.testnet", "bayo.testnet"]);
    expect(n.text).toContain("1 hour");
    const ext = s("Waiting", { proposal: waiting({ waiting_ends_at_ms: 80 * MIN }), options, extension: { proposal_id: 1, total_ms: 60 * MIN, count: 1, pending: null } });
    const e = find(notices(null, ext), "extended");
    expect(e.key).toBe(`kemi.testnet:extended:1:${80 * MIN}`);
    expect(recipients(ext, e)).toEqual(expect.arrayContaining(["sade.testnet", "bayo.testnet", "amara.testnet", "kemi.testnet"]));
    // also noticed from the end moving, with the same key
    expect(find(notices(s("Waiting", { proposal: waiting(), options }), { ...ext, extension: null }), "extended").key).toBe(e.key);
  });
});

describe("transfers", () => {
  it("says how heirs receive, by release mode (D19)", () => {
    const auto = find(notices(null, s("Eligible", { proposal: waiting(), options: { mode: "Automatic", delay_signers: [], delay_quorum: 0 } })), "eligible");
    expect(auto.text).toContain("automatically");
    expect(find(notices(null, s("Eligible", { proposal: waiting() })), "eligible").text).toContain("Open Behest");
  });

  it("tells only the receiving heir that a transfer arrived, with an explorer link per chain", () => {
    const p = waiting({
      transfers: [
        tr({ state: "Confirmed", tx_hash: "0xfeed" }),
        tr({ heir: "tobi.testnet", asset: "Btc", amount: "150000", state: "Confirmed", tx_hash: "ab".repeat(32) }),
        tr({ heir: "tobi.testnet", asset: "Near", amount: "2500000000000000000000000", state: "Confirmed", tx_hash: null }),
      ],
    });
    const cur = s("Executing", { proposal: p, now: 30 * MIN });
    const confirmed = notices(null, cur).filter((n) => n.kind === "transfer_confirmed");
    expect(confirmed.map((n) => recipients(cur, n))).toEqual([["amara.testnet"], ["tobi.testnet"], ["tobi.testnet"]]);
    expect(confirmed[0]!.links[0]!.url).toBe("https://sepolia.etherscan.io/tx/0xfeed");
    expect(confirmed[1]!.links[0]!.url).toBe(`https://mempool.space/testnet4/tx/${"ab".repeat(32)}`);
    expect(confirmed[1]!.text).toContain("0.0015 BTC");
    expect(confirmed[2]!.text).toContain("2.5 NEAR");
    expect(confirmed[2]!.links).toEqual([]);
  });

  it("tells heir and guardians about a failure: once per reason when retried automatically, else once per attempt", () => {
    const failed = (failure: string, attempts: number) => notices(null, s("Executing", { proposal: waiting({ transfers: [tr({ state: "Failed", failure, attempts })] }) })).find((n) => n.kind === "transfer_failed");
    expect(failed("Stuck", 1)!.key).toBe(failed("Stuck", 2)!.key);
    expect(failed("Conflict", 1)!.key).not.toBe(failed("Conflict", 2)!.key);
    expect(failed("Rechained", 1)).toBeUndefined();
    const n = failed("Conflict", 1)!;
    expect(recipients(s("Executing"), n)).toEqual(["dayo.testnet", "funmi.testnet", "chidi.testnet", "amara.testnet"]);
    expect(n.text).toContain("safe");
  });

  it("announces a proven revert being re-issued under a new nonce (D22)", () => {
    const before = s("Executing", { proposal: waiting({ transfers: [tr({ state: "Failed", failure: "Reverted", attempts: 1, eth_tx: { nonce: 4 }, tx_hash: "0x01" })] }) });
    const after = s("Executing", { proposal: waiting({ transfers: [tr({ state: "Signed", attempts: 2, eth_tx: { nonce: 7 } })] }) });
    const n = find(notices(before, after), "transfer_reissued");
    expect(n.key).toBe("kemi.testnet:reissued:1:0:7");
    expect(n.text).toContain("proven");
  });

  it("tells both people and the guardians when an unclaimed share moves (D17)", () => {
    const before = s("Eligible", { proposal: waiting() });
    const after = s("Eligible", { proposal: waiting({ transfers: [tr({ heir: "bisi.testnet" })] }) });
    const n = find(notices(before, after), "transfer_reassigned");
    expect(recipients(after, n)).toEqual(["dayo.testnet", "funmi.testnet", "chidi.testnet", "amara.testnet", "bisi.testnet"]);
  });

  it("settles to everyone on the plan", () => {
    const cur = s("Settled", { proposal: waiting({ transfers: [tr({ state: "Confirmed" })] }) });
    expect(find(notices(null, cur), "settled").to).toEqual(["owner", "guardians", "heirs"]);
  });
});

describe("owner vault withdrawals", () => {
  it("tells the owner when a withdrawal arrives or needs attention", () => {
    const before = s("Active", { withdrawal: tr({ heir: "kemi.testnet", asset: "Btc", amount: "5000", state: "Broadcast", tx_hash: "cd".repeat(32) }) });
    const ok = notices(before, s("Active", { withdrawal: tr({ heir: "kemi.testnet", asset: "Btc", amount: "5000", state: "Confirmed", tx_hash: "cd".repeat(32) }) }));
    expect(ok.map((n) => [n.kind, n.to])).toEqual([["withdrawal_confirmed", ["owner"]]]);
    expect(ok[0]!.links[0]!.url).toContain("mempool.space/testnet4/tx/");
    const bad = notices(before, s("Active", { withdrawal: tr({ heir: "kemi.testnet", state: "Failed", failure: "Dropped", attempts: 1, eth_tx: { nonce: 3 } }) }));
    expect(bad.map((n) => n.kind)).toEqual(["withdrawal_failed"]);
    // an old withdrawal seen on the first look at a plan isn't news
    expect(kinds(null, s("Active", { withdrawal: tr({ state: "Confirmed", tx_hash: "0x1" }) }))).toEqual([]);
    const done = s("Active", { withdrawal: tr({ state: "Confirmed", tx_hash: "0x1" }) });
    expect(kinds(done, done)).toEqual([]);
  });
});

describe("wording and helpers", () => {
  it("never says or implies the owner died", () => {
    const all = [
      ...notices(null, s("Overdue")),
      ...notices(null, s("Settled", { proposal: waiting({ transfers: [tr({ state: "Confirmed" })] }) })),
      ...notices(null, s("Eligible", { proposal: waiting() })),
      ...notices(s("Waiting", { proposal: waiting() }), s("Active", { history: [], lastCheckIn: 15 * MIN })),
    ];
    for (const n of all) expect(`${n.subject} ${n.text}`).not.toMatch(/\b(died|death|dead|deceased|passed away|estate)\b/i);
  });

  it("formats amounts in whole units", () => {
    expect(formatAmount("1500000000000000000", "Eth")).toBe("1.5");
    expect(formatAmount("123", { Erc20: "0xt" }, { tokens: { "0xt": { symbol: "USDC", decimals: 6 } } })).toBe("0.000123");
    expect(formatAmount("7", { Erc20: "0xunknown" })).toBe("7 units of");
  });

  it("links the plan in the app when an app URL is configured", () => {
    const [n] = notices(null, s("Overdue"), { appUrl: "https://behest.example/" });
    expect(n!.links).toEqual([{ label: "Open the plan in Behest", url: "https://behest.example/plan/kemi.testnet" }]);
  });
});
