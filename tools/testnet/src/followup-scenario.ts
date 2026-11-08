// Live Stage 2 demo: follow-up release rounds (D21).
//
//   Escrow 0.05 NEAR. Rules: Tobi gets 0.01 NEAR fixed first, the rest 60/40.
//   1. A normal release runs and settles.
//   2. A friend deposits 0.02 NEAR afterwards. The owner never checks in, so
//      Amara (an heir) starts a follow-up round; the contract records what it
//      counted, guardians approve, and both heirs receive. The fixed amount was
//      already paid, so round 2 is a plain 60/40 split.
//   3. The history shows both rounds, and the owner can still check in (this
//      used to fail once a release had settled).
// Usage: pnpm --filter @behest/testnet e2e-followup
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { account, call, loadDeployment, log, reclaimScenarioOwners, view, waitForKey } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.05");
const LATER = nearToYocto("0.02");
const FIXED = nearToYocto("0.01");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: unknown; amount: string; state: string }
interface Proposal { id: number; proposer: string; approvals: string[]; waiting_ends_at_ms: number | null; transfers: Transfer[] }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { escrow: string; last_check_in_ms: number; proposal: null | Proposal } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, tries = 20): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await f();
    if (v) return v;
    await sleep(3_000);
  }
  throw new Error(`timed out: ${what}`);
}
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
async function makeAccount(prefix: string, near: `${number}`) {
  const kp = KeyPair.fromRandom("ed25519");
  const sub = `${prefix}${Date.now().toString(36)}`;
  const id = `${sub}.${d.owner}`;
  await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto(near) });
  await waitForKey(id, kp.getPublicKey().toString());
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return id;
}
const near = (ts: Transfer[], heir: string) => BigInt(ts.find((t) => t.heir === heir && t.asset === "Near")?.amount ?? "0");
async function runRound(owner: string, proposer: string): Promise<Transfer[]> {
  await call(proposer, C, "propose_release", { owner });
  const p = await until("proposal visible", async () => (await plan(owner)).plan.proposal);
  if (proposer !== G1) await call(G1, C, "approve_release", { owner, proposal_id: p.id });
  await call(G2, C, "approve_release", { owner, proposal_id: p.id });
  const end = await until("approved", async () => (await plan(owner)).plan.proposal?.waiting_ends_at_ms);
  await waitChain(owner, end);
  await call(AMARA, C, "claim", { owner }, { tgas: 100 });
  await call(TOBI, C, "claim", { owner }, { tgas: 100 });
  const done = await until("settled", async () => {
    const v = await plan(owner);
    return v.status === "Settled" && v.plan.proposal;
  });
  return done.transfers;
}

// ------------------------------------------------------------------ setup
const owner = await makeAccount("fup", "0.3");
await call(owner, C, "set_plan", {
  plan: {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: d.guardians,
    quorum: 2,
    heirs: [
      { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: null },
      { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null },
    ],
  },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "set_release_rules", { rules: { fixed: [{ heir: TOBI, asset: "Near", amount: FIXED.toString() }], remainder_to: null, alternates: [], fallback: null, claim_window_ms: 0 } }, { deposit: nearToYocto("0.01") });
await call(owner, C, "deposit", { owner }, { deposit: ESCROW });
log("plan", { owner });

// ------------------------------------------------------- 1. first release
await waitChain(owner, (await plan(owner)).overdue_at_ms);
const r1 = await runRound(owner, G1);
const rest1 = ESCROW - FIXED;
assert(near(r1, TOBI) === FIXED + (rest1 * 4000n) / 10_000n, "round 1: Tobi gets fixed + 40%");
assert(near(r1, AMARA) === (rest1 * 6000n) / 10_000n, "round 1: Amara 60% of the rest");
log("round 1 settled", { amara: near(r1, AMARA).toString(), tobi: near(r1, TOBI).toString() });

// ------------------------------------- 2. a late deposit; heir follows up
await call(d.owner, C, "deposit", { owner }, { deposit: LATER });
const after = await until("archived and overdue", async () => {
  const v = await plan(owner);
  return v.status === "Overdue" && !v.plan.proposal && v;
});
assert(BigInt(after.plan.escrow) === LATER, "the late deposit is in escrow");
const r2 = await runRound(owner, AMARA);
const hist = await view<Proposal[]>(C, "get_release_history", { owner });
const round2 = hist[hist.length - 1]!;
assert(round2.proposer === AMARA, "round 2 proposed by the heir");
assert(near(r2, AMARA) === (LATER * 6000n) / 10_000n && near(r2, TOBI) === (LATER * 4000n) / 10_000n, "round 2: plain 60/40, the fixed amount isn't paid twice");
log("round 2 (follow-up by Amara) settled", { amara: near(r2, AMARA).toString(), tobi: near(r2, TOBI).toString() });

// ------------------------------------------------- 3. history; owner back
assert(hist.length === 2, `history has both rounds (has ${hist.length})`);
await call(owner, C, "check_in", {});
const back = await until("owner active", async () => {
  const v = await plan(owner);
  return v.status === "Active" && v;
});
const paid = await view<{ heir: string; amount: string }[]>(C, "get_fixed_paid", { owner });
assert(paid.length === 1 && paid[0]!.heir === TOBI && BigInt(paid[0]!.amount) === FIXED, "fixed amount recorded as paid once");
log("owner checked in after two settled rounds", { status: back.status, history: (await view<Proposal[]>(C, "get_release_history", { owner })).length });
console.log("✓ follow-up round started by an heir, fixed amount paid once, owner can check in after a release");
