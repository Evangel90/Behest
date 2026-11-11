// Live Stage 2 demo: release rules (D17).
//
//   Escrow 0.05 NEAR + 7 yocto. Rules: Tobi gets 0.01 NEAR fixed first, the
//   rest is split 60/40, and Amara gets the rounding remainder, so every yocto
//   is distributed. Kemi is Amara's named alternate; Ngo (a charity stand-in)
//   is the plan's fallback. Claim window: 1 minute.
//   1. Nobody claims. After one window anyone (a guardian here) reassigns
//      Amara's share to Kemi, and Tobi's (no alternate) to the fallback.
//   2. Kemi and the fallback claim and receive exactly those amounts.
// Usage: pnpm --filter @behest/testnet e2e-rules
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, actions, nearToYocto } from "near-api-js";
import { account, call, loadDeployment, log, provider, reclaimScenarioOwners, view, waitForKey, payTier } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.05") + 7n;
const FIXED = nearToYocto("0.01");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: unknown; destination: string; amount: string; state: string }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { escrow: string; proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
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

// ------------------------------------------------------------------ setup
const owner = await makeAccount("rule", "0.3");
const kemi = await makeAccount("kemi", "0.15");
const fallback = await makeAccount("ngo", "0.15");
await payTier(C, owner, 2, d.admin);
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
await call(owner, C, "set_release_rules", {
  rules: {
    fixed: [{ heir: TOBI, asset: "Near", amount: FIXED.toString() }],
    remainder_to: AMARA,
    alternates: [{ heir: AMARA, recipient: { account_id: kemi, near_destination: kemi, eth_destination: null } }],
    fallback: { account_id: fallback, near_destination: fallback, eth_destination: null },
    claim_window_ms: MINUTE,
  },
}, { deposit: nearToYocto("0.01") });
await call(owner, C, "deposit", { owner }, { deposit: ESCROW });
log("plan with release rules", { owner, alternate: kemi, fallback });

// ------------------------------------------------------- release snapshot
await waitChain(owner, (await plan(owner)).overdue_at_ms);
await call(G1, C, "propose_release", { owner });
await call(G2, C, "approve_release", { owner, proposal_id: (await plan(owner)).plan.proposal!.id });
let ts = (await plan(owner)).plan.proposal!.transfers;
const snap = Object.fromEntries(ts.map((t) => [t.heir, BigInt(t.amount)]));
const amt = (heir: string) => snap[heir]!;
const left = ESCROW - FIXED;
const share = (bps: bigint) => (left * bps) / 10_000n;
assert(amt(TOBI) === FIXED + share(4000n), "Tobi: fixed + 40% of the rest");
assert(amt(AMARA) === left - share(4000n), "Amara: 60% + remainder");
assert(amt(AMARA) + amt(TOBI) === ESCROW && BigInt((await plan(owner)).plan.escrow) === 0n, "every yocto distributed");
log("snapshot", { amara: amt(AMARA).toString(), tobi: amt(TOBI).toString(), remainderToAmara: (left - share(4000n) - share(6000n)).toString() });

// ------------------------------------- 1. nobody claims; window passes
const end = (await plan(owner)).plan.proposal!.waiting_ends_at_ms!;
await waitChain(owner, end + MINUTE);
const ia = ts.findIndex((t) => t.heir === AMARA);
const it = ts.findIndex((t) => t.heir === TOBI);
await call(G1, C, "reassign_unclaimed", { owner, index: ia });
await call(G1, C, "reassign_unclaimed", { owner, index: it });
// RPC nodes can lag a block behind the call's own node: poll until visible.
for (let i = 0; i < 10; i++) {
  ts = (await plan(owner)).plan.proposal!.transfers;
  if (ts[ia]!.heir === kemi && ts[it]!.heir === fallback) break;
  await sleep(2_000);
}
assert(ts[ia]!.heir === kemi && ts[ia]!.destination === kemi, "Amara's share now Kemi's");
assert(ts[it]!.heir === fallback && ts[it]!.destination === fallback, "Tobi's share now the fallback's");
log("unclaimed shares reassigned", { [kemi]: ts[ia]!.amount, [fallback]: ts[it]!.amount });

// ------------------------------------------------- 2. they claim it
const before = { kemi: await balance(kemi), fallback: await balance(fallback) };
await call(kemi, C, "claim", { owner }, { tgas: 100 });
await call(fallback, C, "claim", { owner }, { tgas: 100 });
let p = await plan(owner);
for (let i = 0; i < 10 && p.status !== "Settled"; i++) await sleep(3_000), (p = await plan(owner));
assert(p.status === "Settled", `plan settled (is ${p.status})`);
// each paid its own claim gas, so check the incoming transfer exactly via the
// balance gain plus at most 0.01 NEAR of gas
const gain = { kemi: (await balance(kemi)) - before.kemi, fallback: (await balance(fallback)) - before.fallback };
const GAS = nearToYocto("0.01");
assert(gain.kemi > amt(AMARA) - GAS && gain.kemi <= amt(AMARA), "Kemi received Amara's share");
assert(gain.fallback > amt(TOBI) - GAS && gain.fallback <= amt(TOBI), "fallback received Tobi's share");
log("alternate and fallback paid", { kemi: gain.kemi.toString(), fallback: gain.fallback.toString() });

// cleanup: return the stand-in accounts' NEAR to the deployment owner
for (const id of [kemi, fallback]) {
  await account(id).signAndSendTransaction({ receiverId: id, actions: [actions.deleteAccount(d.owner)] });
  rmSync(join(dir, `${id}.json`));
}
console.log("✓ fixed amount, remainder, alternate and fallback applied as written");
