import { describe, expect, it } from "vitest";
import { countdown, nextStep, timeline, TRANSFER_PROGRESS } from "../src/lib/guide";
import { splitEvenly, guardianErrors, heirErrors, timingErrors, fromMs, toMs, looksLikeNearAccount, sharesTotal, stepOf } from "../src/lib/wizard";
import type { PlanInput, PlanView, Proposal } from "../src/lib/types";

const DAY = 86_400_000;
const policy: PlanInput = {
  check_in_interval_ms: 90 * DAY,
  grace_ms: 7 * DAY,
  waiting_period_ms: 30 * DAY,
  guardians: ["dayo.testnet", "funmi.testnet", "chidi.testnet"],
  quorum: 2,
  heirs: [
    { account_id: "amara.testnet", share_bps: 6000, near_destination: "amara.testnet", eth_destination: null },
    { account_id: "tobi.testnet", share_bps: 4000, near_destination: "tobi.testnet", eth_destination: null },
  ],
};
const proposal = (extra: Partial<Proposal> = {}): Proposal => ({
  id: 3,
  plan_version: 1,
  proposer: "dayo.testnet",
  created_at_ms: 1_000,
  approvals: ["dayo.testnet"],
  rejections: [],
  approved_at_ms: null,
  waiting_ends_at_ms: null,
  near_snapshot: "0",
  eth_snapshot: "0",
  eth_fee_reserve: "0",
  eth_gas_limit: 0,
  transfers: [],
  ...extra,
});
const view = (status: PlanView["status"], p: Proposal | null = null): PlanView => ({
  status,
  overdue_at_ms: 500,
  now_ms: 0,
  plan: { owner: "kemi.testnet", version: 1, policy, last_check_in_ms: 100, escrow: "0", eth_next_nonce: 0, proposal: p, proposals_opened: 0 },
});

describe("countdown", () => {
  it("picks the two most useful units", () => {
    expect(countdown(0)).toBe("now");
    expect(countdown(-5)).toBe("now");
    expect(countdown(12_400)).toBe("12s");
    expect(countdown(4 * 60_000 + 5_000)).toBe("4m 05s");
    expect(countdown(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(countdown(2 * DAY + 4 * 3_600_000 + 1)).toBe("2d 4h");
  });
});

describe("timeline", () => {
  it("marks stages done, current and upcoming with known times", () => {
    const t = timeline(view("Waiting", proposal({ approved_at_ms: 2_000, waiting_ends_at_ms: 9_000 })));
    expect(t.map((s) => s.state)).toEqual(["done", "done", "done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(t[0]!.at).toBe(100);
    expect(t[1]!.at).toBe(500);
    expect(t[2]!.at).toBe(1_000);
    expect(t[3]!.at).toBe(2_000);
    expect(t[4]!.at).toBe(9_000);
    expect(t[1]!.label).toBe("Owner unreachable");
  });
  it("orders transfer progress", () => {
    expect(TRANSFER_PROGRESS.Pending).toBeLessThan(TRANSFER_PROGRESS.Signing);
    expect(TRANSFER_PROGRESS.Broadcast).toBeLessThan(TRANSFER_PROGRESS.Confirmed);
  });
});

describe("next step", () => {
  it("leads the owner to cancel while a release is open, never implying death", () => {
    const s = nextStep(view("Waiting", proposal({ waiting_ends_at_ms: 9_000 })), "owner", { now: 0 });
    expect(s.tone).toBe("urgent");
    expect(s.deadline?.at).toBe(9_000);
    for (const st of ["Active", "Overdue", "Proposed", "Waiting", "Eligible", "Executing", "Settled"] as const)
      for (const r of ["owner", "guardian", "heir", "delay", "public"] as const) {
        const n = nextStep(view(st, proposal({ waiting_ends_at_ms: 9_000 })), r, { now: 0, me: "funmi.testnet" });
        expect(`${n.title} ${n.body}`).not.toMatch(/death|died|dead|deceased|passed away/i);
      }
  });
  it("asks a guardian to vote only until they have", () => {
    expect(nextStep(view("Proposed", proposal()), "guardian", { now: 0, me: "funmi.testnet" }).title).toBe("Your vote is needed.");
    expect(nextStep(view("Proposed", proposal()), "guardian", { now: 0, me: "dayo.testnet" }).title).toBe("You've voted.");
  });
  it("tells an heir when it's ready", () => {
    expect(nextStep(view("Eligible", proposal()), "heir", { now: 0, me: "x7f2-amara.demo.testnet" }).title).toBe("It's ready for you, Amara.");
    expect(nextStep(view("Active"), "heir", { now: 0, me: "amara.testnet" }).title).toBe("Nothing for you to do yet, Amara.");
  });
  it("asks a delay signer to vote on a pending extension", () => {
    const v = view("Waiting", proposal({ waiting_ends_at_ms: 9_000 }));
    expect(nextStep(v, "delay", { now: 0, delay: { pending: true, voted: false, capLeft: true } }).tone).toBe("attention");
    expect(nextStep(v, "delay", { now: 10_000, delay: { pending: true, voted: false, capLeft: true } }).title).toBe("Nothing for you to do yet.");
  });
});

describe("setup wizard", () => {
  it("splits shares evenly to exactly 100%", () => {
    expect(splitEvenly(1)).toEqual(["100"]);
    expect(splitEvenly(2)).toEqual(["50", "50"]);
    expect(splitEvenly(3)).toEqual(["33.34", "33.33", "33.33"]);
    expect(splitEvenly(8)).toEqual(Array(8).fill("12.5"));
    for (const n of [3, 6, 7, 9]) expect(sharesTotal(splitEvenly(n).map((pct) => ({ account: "", pct, near: "", eth: "" })))).toBe(10_000);
  });
  it("round-trips timers through the largest whole unit", () => {
    expect(fromMs(90 * DAY)).toEqual({ n: "90", unit: "days" });
    expect(fromMs(2 * 3_600_000)).toEqual({ n: "2", unit: "hours" });
    expect(fromMs(120_000)).toEqual({ n: "2", unit: "minutes" });
    expect(toMs({ n: "1.5", unit: "days" })).toBe(1.5 * DAY);
  });
  it("applies demo and production timer limits", () => {
    const t = { checkIn: { n: "5", unit: "minutes" as const }, grace: { n: "0", unit: "minutes" as const }, waiting: { n: "5", unit: "minutes" as const } };
    expect(timingErrors(t, true)).toEqual({});
    expect(Object.keys(timingErrors(t, false)).sort()).toEqual(["checkIn", "grace", "waiting"]);
    expect(timingErrors({ ...t, checkIn: { n: "", unit: "days" } }, true).checkIn).toBe("Enter a number.");
  });
  it("flags guardian problems on the field that caused them", () => {
    const e = guardianErrors(["dayo.testnet", "kemi.testnet", "Dayo.testnet", "not an account", ""], "4", "kemi.testnet");
    expect(e["guardian.1"]).toMatch(/own plan/);
    expect(e["guardian.2"]).toBe("Already listed.");
    expect(e["guardian.3"]).toMatch(/NEAR account/);
    expect(e["guardian.4"]).toBeUndefined();
    expect(guardianErrors(["a.testnet", "b.testnet"], "3", "kemi.testnet").quorum).toBe("Choose between 1 and 2.");
    expect(guardianErrors([""], "1", "kemi.testnet").guardians).toBeDefined();
  });
  it("flags heir problems and the share total", () => {
    const e = heirErrors(
      [
        { account: "amara.testnet", pct: "60", near: "", eth: "0x123" },
        { account: "dayo.testnet", pct: "30.555", near: "", eth: "" },
      ],
      "kemi.testnet",
      ["dayo.testnet"],
    );
    expect(e["heir.0.eth"]).toMatch(/0x followed by 40/);
    expect(e["heir.1.account"]).toMatch(/both an heir and a guardian/);
    expect(e["heir.1.pct"]).toBe("At most two decimals.");
    expect(e.shares).toMatch(/must add up to 100%/);
    expect(heirErrors([{ account: "amara.testnet", pct: "100", near: "", eth: "" }], "kemi.testnet", [])).toEqual({});
  });
  it("recognises account formats and maps errors to steps", () => {
    expect(looksLikeNearAccount("x7f2-amara.demo-funder.testnet")).toBe(true);
    expect(looksLikeNearAccount("0x71c7656ec7ab88b098defb751b7401b5f6d8976f")).toBe(true);
    expect(looksLikeNearAccount("has space.testnet")).toBe(false);
    expect(stepOf("heir.2.eth")).toBe("heirs");
    expect(stepOf("quorum")).toBe("guardians");
    expect(stepOf("grace")).toBe("timing");
  });
});
