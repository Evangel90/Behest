// Live D30 + D31 demo: heirs prove control of their destinations, and ask
// for a new one while the owner is active. Demo timers: 1-minute edit notice.
//
//   1. A fresh owner (Standard tier) saves a plan: Amara receives NEAR at a
//      wallet sub-account, Ethereum at a fresh key, Bitcoin at a fresh tb1q.
//   2. Proofs: the NEAR wallet calls prove_destination itself; a stranger
//      submits Amara's personal_sign (EIP-191) and Bitcoin signed message
//      (BIP-137). A wrong signature and an unregistered address are refused.
//   3. Requests: a stranger can't ask (E_NOT_RECIPIENT). Amara asks for a new
//      Ethereum address, proved with a signature; the owner rejects it and
//      nothing changes. With a 1-minute edit notice on, Amara asks for a new
//      NEAR wallet, which proves itself; the owner approves; it's queued,
//      then applied after the notice, and the proof carries over.
// Usage: pnpm --filter @behest/testnet e2e-destinations
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { newKey, p2wpkh } from "./btc.js";
import { ensureScenarioFunds } from "./funding.js";
import { account, call, loadDeployment, log, payTier, reclaimScenarioOwners, view, waitForKey } from "./near.js";
import { signBitcoinMessage } from "./proofs.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
await ensureScenarioFunds(d, 0.4);
const C = d.contract;
const [G1, G2, G3] = d.guardians as [string, string, string];
const [AMARA] = d.heirs as [string, string];
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

type Chain = "Near" | "Eth" | "Btc" | "Intents";
interface Dest { account_id: string; chain: Chain; destination: string; proven_at_ms: number | null }
interface Pending { change: Record<string, unknown>; effective_at_ms: number }
interface PlanView { now_ms: number; plan: { policy: { heirs: { near_destination: string | null; eth_destination: string | null }[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const dests = (owner: string) => view<Dest[]>(C, "get_destinations", { owner });
const reqs = (owner: string) => view<Dest[]>(C, "get_destination_requests", { owner });
const proven = (ds: Dest[], chain: Chain) => ds.find((x) => x.account_id === AMARA && x.chain === chain)?.proven_at_ms;

// ------------------------------------------------------------------ setup
const kp = KeyPair.fromRandom("ed25519");
const sub = `dst${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.4") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
const saveKey = (id: string) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
saveKey(owner);
// Amara's two NEAR wallets (any accounts work; sub-accounts of the owner are cheap to make here).
const W1 = `w1.${owner}`;
const W2 = `w2.${owner}`;
for (const p of ["w1", "w2"]) {
  await account(owner).createSubAccount({ accountOrPrefix: p, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.05") });
  await waitForKey(`${p}.${owner}`, kp.getPublicKey().toString());
  saveKey(`${p}.${owner}`);
}
const eth = privateKeyToAccount(generatePrivateKey());
const eth2 = privateKeyToAccount(generatePrivateKey());
const btcKey = newKey();
const btcAddr = p2wpkh(btcKey).address!;
const ETH = eth.address.toLowerCase();
log("owner", { owner, near: W1, eth: ETH, btc: btcAddr });

// 1. Plan.
await payTier(C, owner, 1, d.admin);
await call(owner, C, "set_plan", {
  plan: { check_in_interval_ms: 60 * MINUTE, grace_ms: 0, waiting_period_ms: MINUTE, guardians: [G1, G2, G3], quorum: 2, heirs: [{ account_id: AMARA, share_bps: 10_000, near_destination: W1, eth_destination: ETH }] },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "set_btc_destinations", { destinations: [{ account_id: AMARA, address: btcAddr }] }, { deposit: nearToYocto("0.01") });
let ds = await eventually(() => dests(owner), (x) => x.length === 3 && x.every((y) => !y.proven_at_ms), "three unproven destinations");
log("1. plan saved: three destinations, none proven", ds.map((x) => `${x.chain}:${x.destination}`));

// 2. Proofs.
const msg = (chain: Chain, dest: string) => view<string>(C, "get_proof_message", { owner, account_id: AMARA, chain, destination: dest });
await expectError("E_DESTINATION_PROOF", () => call(AMARA, C, "prove_destination", { owner, account_id: AMARA, chain: "Near", destination: W1, signature: null }));
await call(W1, C, "prove_destination", { owner, account_id: AMARA, chain: "Near", destination: W1, signature: null });
const wrong = await eth2.signMessage({ message: await msg("Eth", ETH) });
await expectError("E_DESTINATION_PROOF", () => call(G1, C, "prove_destination", { owner, account_id: AMARA, chain: "Eth", destination: ETH, signature: wrong }));
await call(G1, C, "prove_destination", { owner, account_id: AMARA, chain: "Eth", destination: ETH, signature: await eth.signMessage({ message: await msg("Eth", ETH) }) });
await call(G1, C, "prove_destination", { owner, account_id: AMARA, chain: "Btc", destination: btcAddr, signature: signBitcoinMessage(await msg("Btc", btcAddr), btcKey) });
await expectError("E_INVALID_DESTINATION", () => call(W2, C, "prove_destination", { owner, account_id: AMARA, chain: "Near", destination: W2, signature: null }));
ds = await eventually(() => dests(owner), (x) => x.every((y) => y.proven_at_ms), "all three proven");
log("2. NEAR (by calling), Ethereum (EIP-191) and Bitcoin (BIP-137) proven");

// 3a. Requests: who may ask; a rejected request changes nothing.
await expectError("E_NOT_RECIPIENT", () => call(G2, C, "request_destination_change", { owner, chain: "Near", destination: W2, signature: null }));
const ETH2 = eth2.address.toLowerCase();
await call(AMARA, C, "request_destination_change", { owner, chain: "Eth", destination: ETH2, signature: await eth2.signMessage({ message: await msg("Eth", ETH2) }) });
await eventually(() => reqs(owner), (x) => x[0]?.destination === ETH2 && !!x[0]?.proven_at_ms, "proven Ethereum request open");
await call(owner, C, "respond_destination_change", { account_id: AMARA, chain: "Eth", approve: false });
await eventually(() => reqs(owner), (x) => x.length === 0, "request closed");
assert((await plan(owner)).plan.policy.heirs[0]!.eth_destination === ETH, "rejected: unchanged");
log("3a. stranger refused; a proven Ethereum request rejected, address unchanged");

// 3b. Approved under an edit notice.
await call(owner, C, "set_edit_notice", { notice_ms: MINUTE }, { deposit: nearToYocto("0.01") });
await call(AMARA, C, "request_destination_change", { owner, chain: "Near", destination: W2, signature: null });
await call(W2, C, "prove_destination", { owner, account_id: AMARA, chain: "Near", destination: W2, signature: null });
await eventually(() => reqs(owner), (x) => x[0]?.destination === W2 && !!x[0]?.proven_at_ms, "W2 requested and proven");
await call(owner, C, "respond_destination_change", { account_id: AMARA, chain: "Near", approve: true }, { deposit: nearToYocto("0.01") });
const pend = await eventually(() => view<Pending[]>(C, "get_pending_changes", { owner }), (x) => x.length === 1, "approval queued");
assert((await plan(owner)).plan.policy.heirs[0]!.near_destination === W1, "still W1 during the notice");
log("3b. W2 requested, proven and approved: queued for the edit notice");
await expectError("E_CHANGE_NOT_DUE", () => call(G1, C, "apply_changes", { owner, kind: null }));
for (;;) {
  const now = (await plan(owner)).now_ms;
  if (now >= pend[0]!.effective_at_ms) break;
  await sleep(Math.min(15_000, pend[0]!.effective_at_ms - now + 2_000));
}
await call(G1, C, "apply_changes", { owner, kind: null });
await eventually(() => plan(owner), (x) => x.plan.policy.heirs[0]!.near_destination === W2, "W2 applied");
ds = await eventually(() => dests(owner), (x) => x.find((y) => y.chain === "Near")?.destination === W2, "views caught up");
assert(proven(ds, "Near") && proven(ds, "Eth") && proven(ds, "Btc"), "the NEAR proof carried over; the others still stand");
log("3c. applied after the notice; W2 shows as proven");

log("e2e-destinations passed", { owner });
