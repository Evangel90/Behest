// Live D33 demo: sealed (private) heirs. Demo timers: 1-minute check-ins.
//
//   1. A fresh owner (Standard tier) saves a private plan: two heirs, Amara
//      60% (paid at a hidden wallet) and Tobi 40%, sealed as fingerprints
//      computed off-chain. get_plan shows no heirs. Reveals are refused while
//      the owner is active.
//   2. Overdue: a stranger reveals Amara's record (records are bearer
//      proofs). A wrong salt and a second reveal are refused; a release is
//      refused while Tobi is still unrevealed.
//   3. The owner checks in: the plan is sealed again.
//   4. Overdue again: Amara reveals herself, Tobi never does. After the
//      reveal window the release starts with Amara alone (Redistribute): she
//      receives everything at her hidden wallet.
// Usage: pnpm --filter @behest/testnet e2e-private
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { ensureScenarioFunds } from "./funding.js";
import { account, call, loadDeployment, log, payTier, provider, reclaimScenarioOwners, view, waitForKey } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
await ensureScenarioFunds(d, 0.6);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => unknown, msg: string): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await read();
    if (ok(v)) return v;
    if (i >= 10) throw new Error(`assertion failed: ${msg}`);
    await sleep(1_500);
  }
}
async function expectError(code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const detail = JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (String((e as Error)?.message ?? e).includes(code) || detail.includes(code)) return log(`rejected as expected: ${code}`);
    throw new Error(`expected ${code}, got: ${String(e)} ${detail.slice(0, 400)}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

interface Rec { account_id: string; share_bps: number; near_destination: string | null; eth_destination: string | null; btc_destination: string | null; salt: string }
interface PV { commitments: string[]; revealed: { index: number; account_id: string }[]; reveal_opens_at_ms: number; reveal_deadline_ms: number }
interface PlanView { status: string; now_ms: number; overdue_at_ms: number; plan: { escrow: string; policy: { heirs: { account_id: string; share_bps: number; near_destination: string | null }[] }; proposal: { id: number; waiting_ends_at_ms: number | null; transfers: { heir: string; destination: string; amount: string }[] } | null } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const priv = (owner: string) => view<PV | null>(C, "get_private_heirs", { owner });
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}
// Same text as contracts/behest/src/privacy.rs and apps/web/src/lib/sealed.ts.
const fingerprint = (owner: string, r: Rec) =>
  createHash("sha256").update(["behest-heir-v1", C, owner, r.account_id, r.share_bps, r.near_destination ?? "", r.eth_destination ?? "", r.btc_destination ?? "", r.salt].join("\n")).digest("hex");

// ------------------------------------------------------------------ setup
const kp = KeyPair.fromRandom("ed25519");
const sub = `prv${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.5") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
// Amara's hidden wallet: a fresh account nobody links to her until she reveals.
const WALLET = `vault.${owner}`;
await account(owner).createSubAccount({ accountOrPrefix: "vault", publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.01") });
await waitForKey(WALLET, kp.getPublicKey().toString());

const amara: Rec = { account_id: AMARA, share_bps: 6000, near_destination: WALLET, eth_destination: null, btc_destination: null, salt: randomBytes(32).toString("hex") };
const tobi: Rec = { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null, btc_destination: null, salt: randomBytes(32).toString("hex") };
const commitments = [fingerprint(owner, amara), fingerprint(owner, tobi)];
const ESCROW = nearToYocto("0.2");

// 1. Private plan.
await payTier(C, owner, 1, d.admin);
await call(owner, C, "set_private_plan", {
  plan: { check_in_interval_ms: MINUTE, grace_ms: 0, waiting_period_ms: MINUTE, guardians: d.guardians, quorum: 2, heirs: [] },
  sealed: { commitments, reveal_window_ms: 2 * MINUTE, unrevealed: "Redistribute" },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "deposit", { owner }, { deposit: ESCROW });
let p = await eventually(() => plan(owner), (x) => BigInt(x.plan.escrow) === ESCROW, "plan saved");
assert(p.plan.policy.heirs.length === 0, "no heirs in the public plan");
assert(!JSON.stringify(p).includes(AMARA) && !JSON.stringify(p).includes(WALLET), "nothing about Amara is public");
assert((await view<string>(C, "get_heir_commitment", { owner, record: amara })) === commitments[0], "off-chain fingerprint matches the contract's");
assert((await priv(owner))?.commitments.length === 2, "two sealed heirs");
await expectError("E_REVEAL_NOT_OPEN", () => call(G1, C, "reveal_heir", { owner, record: amara }));
log("1. private plan saved: 2 fingerprints, no heirs on the public record", { owner });

// 2. Overdue: reveals open.
await waitChain(owner, p.overdue_at_ms);
await expectError("E_UNKNOWN_COMMITMENT", () => call(G1, C, "reveal_heir", { owner, record: { ...amara, salt: "00".repeat(32) } }));
await expectError("E_UNKNOWN_COMMITMENT", () => call(G1, C, "reveal_heir", { owner, record: { ...amara, share_bps: 10_000 } }));
await call(G1, C, "reveal_heir", { owner, record: amara });
await eventually(() => priv(owner), (x) => x?.revealed.length === 1, "Amara revealed");
await expectError("E_ALREADY_REVEALED", () => call(G2, C, "reveal_heir", { owner, record: amara }));
await expectError("E_REVEALS_PENDING", () => call(G1, C, "propose_release", { owner }));
log("2. overdue: a stranger revealed Amara's record; tampered records, a repeat and an early release refused");

// 3. Owner shows up: sealed again.
await call(owner, C, "check_in", { owner: null });
await eventually(() => priv(owner), (x) => x?.revealed.length === 0, "resealed");
log("3. owner checked in: reveals cleared, plan sealed again");

// 4. Overdue again: only Amara reveals; the window passes; release.
p = await plan(owner);
await waitChain(owner, p.overdue_at_ms);
await call(AMARA, C, "reveal_heir", { owner, record: amara });
const pv = await eventually(() => priv(owner), (x) => x?.revealed.length === 1, "Amara revealed again");
log("4. Amara revealed herself; Tobi doesn't. Waiting out the reveal window", { deadline: new Date(pv!.reveal_deadline_ms).toISOString() });
await waitChain(owner, pv!.reveal_deadline_ms + 1_000);
await call(G1, C, "propose_release", { owner });
p = await eventually(() => plan(owner), (x) => !!x.plan.proposal, "proposed");
assert(p.plan.policy.heirs.length === 1 && p.plan.policy.heirs[0]!.account_id === AMARA && p.plan.policy.heirs[0]!.share_bps === 10_000, "Amara takes Tobi's unrevealed share");
await call(G2, C, "approve_release", { owner, proposal_id: p.plan.proposal!.id });
p = await eventually(() => plan(owner), (x) => !!x.plan.proposal?.waiting_ends_at_ms, "approved");
const t = p.plan.proposal!.transfers;
assert(t.length === 1 && t[0]!.heir === AMARA && t[0]!.destination === WALLET && BigInt(t[0]!.amount) === ESCROW, "everything to Amara's hidden wallet");
log("5. release proposed and approved: 100% to Amara at her hidden wallet", t);
await waitChain(owner, p.plan.proposal!.waiting_ends_at_ms! + 1_000);
const before = await balance(WALLET);
await call(AMARA, C, "claim", { owner }, { tgas: 100 });
p = await eventually(() => plan(owner), (x) => x.status === "Settled", "settled");
const gain = (await balance(WALLET)) - before;
assert(gain === ESCROW, `wallet received the escrow (got ${gain})`);
log("6. Amara claimed: her hidden wallet received 0.2 NEAR; plan settled");

log("e2e-private passed", { owner });
