// Live D27 demo: a heir receives through NEAR Intents, on testnet against the
// mock verifier (contracts/mock-intents at behest-<suffix>-intents.testnet;
// the real intents.near and 1Click are mainnet-only and untested here).
//
//   A fresh owner pays the Standard tier, plans 60/40 between Amara (paid
//   into her Intents account) and Tobi (paid to his wallet as before), and
//   escrows NEAR and wNEAR.
//   1. The verifier is set to fail every deposit: the token refunds it all
//      (ft_resolve_transfer), so Amara's claim leaves both her transfers
//      Failed (IntentsRefunded) and nothing counts as paid.
//   2. The verifier hands back half of each deposit: Failed again
//      (IntentsPartlyRefunded); half is recorded as delivered and the wNEAR
//      wrapped for the NEAR share is unwrapped back into escrow.
//   3. The verifier keeps everything: the retries send only the unpaid half
//      and confirm. Amara's Intents balance is exactly her NEAR share plus
//      her wNEAR share (never one and a half), and Behest holds no stray wNEAR.
//   4. Tobi claims to his wallet. Amara withdraws some wNEAR from Intents.
// Usage: pnpm --filter @behest/testnet e2e-intents
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { ensureScenarioFunds } from "./funding.js";
import { account, call, loadDeployment, log, payTier, provider, reclaimScenarioOwners, view, waitForKey } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
await ensureScenarioFunds(d, 0.5);
const C = d.contract;
const V = d.intents;
if (!V) throw new Error("no Intents verifier in the deployment: run deploy-contract first");
const cfg = await view<{ verifier: string; wnear: string } | null>(C, "get_intents_config");
if (cfg?.verifier !== V) throw new Error(`the contract's Intents verifier is ${cfg?.verifier}, not ${V}`);
const WNEAR = cfg.wnear;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.05");
const WRAP = nearToYocto("0.01");
const TOKEN_ID = `nep141:${WNEAR}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: string | { Nep141: string }; amount: string; state: string; failure: string | null }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } })).amount);
const wnear = async (id: string) => BigInt((await view<string | null>(WNEAR, "ft_balance_of", { account_id: id })) ?? "0");
const inIntents = async (id: string) => BigInt((await view<string[]>(V, "mt_batch_balance_of", { account_id: id, token_ids: [TOKEN_ID] }))[0]!);
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}
const behave = (refund_bps: number, fail: boolean) => call(d.admin, V, "set_behaviour", { refund_bps, fail });
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
const isWnear = (t: Transfer) => typeof t.asset === "object" && t.asset.Nep141 === WNEAR;
/** Amara's transfers: [NEAR, wNEAR] with their indexes. */
async function amaras(owner: string) {
  const ts = (await plan(owner)).plan.proposal!.transfers.map((t, i) => ({ ...t, i }));
  return { near: ts.find((t) => t.heir === AMARA && t.asset === "Near")!, token: ts.find((t) => t.heir === AMARA && isWnear(t))! };
}
/** Callbacks (and the unwrap after a refund) land a few blocks later. */
async function settle(owner: string, until: (a: Awaited<ReturnType<typeof amaras>>) => boolean, what: string) {
  for (let i = 0; i < 20; i++) {
    const a = await amaras(owner);
    if (until(a)) return a;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ setup
const owner = await makeAccount("intents", "0.35");
await payTier(C, owner, 1, d.admin);
await call(owner, C, "set_plan", {
  plan: {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: [G1, G2],
    quorum: 2,
    heirs: [
      { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: null },
      { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null },
    ],
  },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "set_intents_delivery", { deliveries: [{ account_id: AMARA, enabled: true, intents_account: null }] }, { deposit: nearToYocto("0.01") });
assert((await view<{ account_id: string }[]>(C, "get_intents_delivery", { owner }))[0]?.account_id === AMARA, "Amara receives through Intents");
await call(owner, C, "deposit", { owner }, { deposit: ESCROW });
await call(owner, WNEAR, "near_deposit", {}, { deposit: WRAP });
// wrap.testnet keeps its storage fee out of a first deposit: escrow what arrived.
await call(owner, WNEAR, "ft_transfer_call", { receiver_id: C, amount: (await wnear(owner)).toString(), msg: owner }, { deposit: 1n, tgas: 100 });
log("Standard plan: Amara through NEAR Intents, Tobi to his wallet", { owner, verifier: V, escrow: "0.05 NEAR + 0.01 wNEAR" });

await waitChain(owner, (await plan(owner)).overdue_at_ms);
await call(G1, C, "propose_release", { owner });
const id = (await plan(owner)).plan.proposal!.id;
await call(G2, C, "approve_release", { owner, proposal_id: id });
await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);
const share = await amaras(owner);
const due = { near: BigInt(share.near.amount), token: BigInt(share.token.amount) };
const startIntents = await inIntents(AMARA);
const behestWnear = await wnear(C);
log("release approved; Amara's shares", { near: due.near.toString(), wnear: due.token.toString() });

try {
  // -------------------------------------------- 1. the verifier fails
  await behave(0, true);
  await call(AMARA, C, "claim", { owner }, { tgas: 300 });
  let a = await settle(owner, (x) => x.near.state === "Failed" && x.token.state === "Failed", "both transfers to fail");
  assert(a.near.failure === "IntentsRefunded" && a.token.failure === "IntentsRefunded", `fully refunded deposits (${a.near.failure}, ${a.token.failure})`);
  assert((await inIntents(AMARA)) === startIntents, "nothing reached Intents");
  for (const t of [a.near, a.token]) assert(BigInt((await view<{ paid: string }>(C, "get_intents_progress", { owner, index: t.i })).paid) === 0n, "nothing counted as paid");
  log("1. verifier failing: the token refunded everything; both transfers Failed (IntentsRefunded), nothing paid");

  // --------------------------------- 2. the verifier hands back half
  await behave(5000, false);
  for (const t of [a.near, a.token]) await call(AMARA, C, "retry_transfer", { owner, index: t.i }, { tgas: 200 });
  a = await settle(owner, (x) => x.near.failure === "IntentsPartlyRefunded" && x.token.failure === "IntentsPartlyRefunded", "partial refunds");
  const half = { near: due.near / 2n, token: due.token / 2n };
  // The unwrap of the refunded wNEAR lands a block or two after the callback.
  let prog = { paid: "0", wrapped: "1" };
  for (let i = 0; i < 15 && prog.wrapped !== "0"; i++) {
    prog = await view<{ paid: string; wrapped: string }>(C, "get_intents_progress", { owner, index: a.near.i });
    if (prog.wrapped !== "0") await sleep(2_000);
  }
  assert(BigInt(prog.paid) === half.near && prog.wrapped === "0", `half of the NEAR share delivered, the rest unwrapped back (${JSON.stringify(prog)})`);
  assert(a.near.state === "Failed" && a.token.state === "Failed", "a partial refund is never paid");
  assert((await inIntents(AMARA)) === startIntents + half.near + half.token, "Intents holds exactly the kept halves");
  log("2. verifier refunding half: Failed (IntentsPartlyRefunded), half recorded as delivered, refund back in escrow");

  // ------------------------------------- 3. the verifier keeps everything
  await behave(0, false);
  for (const t of [a.near, a.token]) await call(AMARA, C, "retry_transfer", { owner, index: t.i }, { tgas: 200 });
  a = await settle(owner, (x) => x.near.state === "Confirmed" && x.token.state === "Confirmed", "confirmation");
  const got = (await inIntents(AMARA)) - startIntents;
  assert(got === due.near + due.token, `Amara's Intents balance grew by exactly her shares (${got} vs ${due.near + due.token})`);
  assert((await wnear(C)) === behestWnear - due.token, `Behest's wNEAR fell by exactly the escrowed share, no stray wNEAR (${await wnear(C)})`);
  log("3. retries sent only the unpaid halves; Amara's Intents balance = her NEAR + wNEAR shares", { received: got.toString() });
} finally {
  await behave(0, false);
}

// ------------------------------------ 4. Tobi direct; Amara withdraws
const tobiBefore = await balance(TOBI);
await call(TOBI, C, "claim", { owner }, { tgas: 300 });
let tobiNear = (await plan(owner)).plan.proposal!.transfers.find((t) => t.heir === TOBI && t.asset === "Near")!;
for (let i = 0; i < 10 && tobiNear.state !== "Confirmed"; i++) {
  await sleep(2_000);
  tobiNear = (await plan(owner)).plan.proposal!.transfers.find((t) => t.heir === TOBI && t.asset === "Near")!;
}
assert(tobiNear.state === "Confirmed" && (await balance(TOBI)) > tobiBefore, "Tobi was paid to his wallet");
const out = due.token;
// A withdrawal is an ft_transfer from the verifier: the wallet must be registered with the token.
if ((await view(WNEAR, "storage_balance_of", { account_id: AMARA })) === null) await call(AMARA, WNEAR, "storage_deposit", { account_id: AMARA, registration_only: true }, { deposit: nearToYocto("0.00125") });
const walletBefore = await wnear(AMARA);
await call(AMARA, V, "ft_withdraw", { token: WNEAR, receiver_id: AMARA, amount: out.toString() }, { deposit: 1n, tgas: 60 });
let walletAfter = await wnear(AMARA);
for (let i = 0; i < 10 && walletAfter !== walletBefore + out; i++) {
  await sleep(2_000);
  walletAfter = await wnear(AMARA);
}
assert(walletAfter === walletBefore + out, "Amara withdrew wNEAR from Intents to her wallet");
log("4. Tobi paid to his wallet; Amara withdrew from Intents", { withdrew: out.toString() });
log("e2e-intents passed", { owner, verifier: V });
