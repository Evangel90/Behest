// Live Stage 2 demo: delay signers (D18) and automatic release (D19).
//
//   Plan in Automatic mode with two delay signers (quorum 2, ≤ 1 minute per
//   extension, ≤ 2 minutes total). Waiting period: 1 minute.
//   1. After approval, the signers extend the waiting period by 1 minute
//      (reason code only). Past the original end a heir still can't claim:
//      the owner's cancel window and the signing cutoff moved with it.
//   2. Amara has a per-heir override back to Claim. When the extended period
//      ends, the executor starts Tobi's transfer on its own (`release`); Tobi
//      signs nothing and receives exactly his share. Amara's share waits
//      until she claims it.
// Usage: pnpm --filter @behest/testnet e2e-auto
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, actions, nearToYocto } from "near-api-js";
import { account, call, loadDeployment, log, provider, reclaimScenarioOwners, view, waitForKey, payTier } from "./near.js";
import { executor } from "./sepolia.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.05");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; amount: string; state: string; failure: string | null }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
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
const owner = await makeAccount("auto", "0.3");
const ds1 = await makeAccount("dsa", "0.05");
const ds2 = await makeAccount("dsb", "0.05");
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
await call(owner, C, "set_release_options", {
  options: {
    mode: "Automatic",
    hybrid_grace_ms: 0,
    delay_signers: [ds1, ds2],
    delay_quorum: 2,
    max_extension_ms: MINUTE,
    max_total_extension_ms: 2 * MINUTE,
    overrides: [{ heir: AMARA, assets: "All", mode: "Claim", hybrid_grace_ms: 0 }],
  },
}, { deposit: nearToYocto("0.01") });
await call(owner, C, "deposit", { owner }, { deposit: ESCROW });
log("automatic-release plan with two delay signers", { owner, delaySigners: [ds1, ds2] });

await waitChain(owner, (await plan(owner)).overdue_at_ms);
await call(G1, C, "propose_release", { owner });
const id = (await plan(owner)).plan.proposal!.id;
await call(G2, C, "approve_release", { owner, proposal_id: id });
const original = (await plan(owner)).plan.proposal!.waiting_ends_at_ms!;

// ------------------------------------------------ 1. delay signers extend
await call(ds1, C, "request_extension", { owner, proposal_id: id, extension_ms: MINUTE, reason: "checking-on-owner" });
await call(ds2, C, "approve_extension", { owner, proposal_id: id });
let extended = 0;
for (let i = 0; i < 10 && extended !== original + MINUTE; i++) {
  extended = (await plan(owner)).plan.proposal!.waiting_ends_at_ms!;
  if (extended !== original + MINUTE) await sleep(2_000);
}
assert(extended === original + MINUTE, "waiting period extended by exactly one minute");
log("waiting period extended", { from: new Date(original).toISOString(), to: new Date(extended).toISOString() });

await waitChain(owner, original + 5_000);
const early = await call(AMARA, C, "claim", { owner }, { tgas: 100 }).then(() => "claimed", (e) => String(e));
assert(early.includes("E_NOT_ELIGIBLE"), `claim inside the extension refused (${early.slice(0, 80)})`);
log("heir claim refused during the extension", { error: "E_NOT_ELIGIBLE" });

// ----------------------------------------- 2. executor releases on its own
const snap = Object.fromEntries((await plan(owner)).plan.proposal!.transfers.map((t) => [t.heir, BigInt(t.amount)]));
const before = { amara: await balance(AMARA), tobi: await balance(TOBI) };
await waitChain(owner, extended);
const engine = executor(C, d.executor);
const stateOf = (p: PlanView, heir: string) => p.plan.proposal!.transfers.find((t) => t.heir === heir)!.state;
let p = await plan(owner);
for (let i = 0; i < 20 && stateOf(p, TOBI) !== "Confirmed"; i++) {
  await engine.tick();
  await sleep(3_000);
  p = await plan(owner);
}
for (let i = 0; i < 3; i++) await engine.tick(); // more passes: Amara's must stay put
p = await plan(owner);
assert(stateOf(p, TOBI) === "Confirmed" && stateOf(p, AMARA) === "Pending", `executor released Tobi only (${stateOf(p, TOBI)}, ${stateOf(p, AMARA)})`);
assert((await balance(TOBI)) - before.tobi === snap[TOBI], "Tobi received exactly his share without signing");
log("executor released Tobi; Amara's share (Claim override) waits", { tobi: snap[TOBI]!.toString() });

await call(AMARA, C, "claim", { owner }, { tgas: 100 });
for (let i = 0; i < 10 && p.status !== "Settled"; i++) await sleep(3_000), (p = await plan(owner));
assert(p.status === "Settled", `plan settled after Amara's claim (is ${p.status})`);
const gain = (await balance(AMARA)) - before.amara;
assert(gain > snap[AMARA]! - nearToYocto("0.01") && gain <= snap[AMARA]!, "Amara received her share, less her own claim gas");
log("Amara claimed", { share: snap[AMARA]!.toString() });

for (const id of [ds1, ds2]) {
  await account(id).signAndSendTransaction({ receiverId: id, actions: [actions.deleteAccount(d.owner)] });
  rmSync(join(dir, `${id}.json`));
}
console.log("✓ delay signers extended the wait; the executor released Tobi automatically and left Amara's share for her claim");
