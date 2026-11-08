// Live Stage 2 demo: Bitcoin testnet4 vault (D20).
//
//   0. A plan gets a Bitcoin vault (an MPC-derived P2WPKH address). Amara's
//      Bitcoin destination is a Taproot address (bech32m), Tobi's a P2WPKH one.
//   1. The funder wallet sends tBTC to the vault. The owner withdraws part of
//      it (D7 for Bitcoin): the contract builds and the MPC signs the tx, the
//      executor broadcasts it, change returns to the vault.
//   2. The owner goes silent; guardians propose with the vault's coin and
//      approve. The proposal reserves fees at the cap and splits the rest 60/40.
//   3. Both heirs claim. Amara's payout spends the vault coin; Tobi's spends
//      Amara's change (chained before either is mined). The executor
//      broadcasts both; once mined the plan settles. Each heir's address holds
//      exactly its snapshot amount.
// Needs BTC_FUNDER_KEY in the root .env holding ≥ 40k testnet4 sats
// (`pnpm btc-funder` prints the address). Blocks take ~10 min, so a full run
// waits for 2–3 of them.
// Usage: pnpm --filter @behest/testnet e2e-btc
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { KeyPair, nearToYocto } from "near-api-js";
import { ESPLORA, NET, funderKey, newKey, p2wpkh, send } from "./btc.js";
import { account, call, loadDeployment, log, reclaimScenarioOwners, view, waitForKey } from "./near.js";
import { executor } from "./sepolia.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const FUND = 30_000;
const WITHDRAW = 5_000;
const VAULT_WITHDRAWAL = 4294967295;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: unknown; destination: string; amount: string; state: string; tx_hash: string | null; failure: string | null }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}
const esplora = async <T>(path: string): Promise<T> => {
  for (let i = 0; ; i++) {
    const r = await fetch(`${ESPLORA}${path}`).catch(() => null);
    if (r?.ok) return (await r.json()) as T;
    if (i > 5) throw new Error(`esplora ${path}: ${r?.status}`);
    await sleep(3_000);
  }
};
const coins = (a: string) => esplora<Utxo[]>(`/address/${a}/utxo`);
/** Sats received at an address, mempool included. */
async function received(a: string) {
  const s = await esplora<{ chain_stats: { funded_txo_sum: number }; mempool_stats: { funded_txo_sum: number } }>(`/address/${a}`);
  return s.chain_stats.funded_txo_sum + s.mempool_stats.funded_txo_sum;
}
async function until<T>(what: string, minutes: number, f: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + minutes * MINUTE;
  for (;;) {
    const v = await f().catch((e) => (log(`${what}: ${String(e).slice(0, 120)}`), null));
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20_000);
  }
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

const funder = p2wpkh(funderKey()).address!;
const have = (await coins(funder)).reduce((a, u) => a + u.value, 0);
if (have < FUND + 2_000) {
  console.error(`The funder wallet ${funder} holds ${have} sats; it needs ≥ ${FUND + 2_000}. Get testnet4 coins from a faucet and rerun.`);
  process.exit(1);
}
const engine = executor(C, d.executor);

// ---------------------------------------------------------- 0. plan + vault
const owner = await makeAccount("btc", "0.3");
// fresh heir wallets: Amara Taproot (bech32m), Tobi P2WPKH (bech32)
const amaraBtc = btc.p2tr(secp256k1.getPublicKey(newKey(), true).slice(1), undefined, NET).address!;
const tobiBtc = p2wpkh(newKey()).address!;
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
await call(G1, C, "register_btc_vault", { owner }, { tgas: 50 });
const vault = await until("vault key", 1, () => view<{ address: string; pubkey: string } | null>(C, "get_btc_vault", { owner }));
await call(owner, C, "set_btc_destinations", { destinations: [{ account_id: AMARA, address: amaraBtc }, { account_id: TOBI, address: tobiBtc }] }, { deposit: nearToYocto("0.01") });
log("plan with a Bitcoin vault", { owner, vault: vault.address, amara: amaraBtc, tobi: tobiBtc });

// ----------------------------------------------- 1. fund, owner withdraws
const fundTx = await send(funderKey(), vault.address, FUND);
log("funded the vault", { txid: fundTx, sats: FUND });
const fundCoin = await until("funding confirms (one block)", 90, async () => (await coins(vault.address)).find((u) => u.txid === fundTx && u.status.confirmed));
await call(owner, C, "withdraw_btc", { utxos: [{ txid: fundCoin.txid, vout: fundCoin.vout, value: String(fundCoin.value) }], amount: String(WITHDRAW), to: funder }, { tgas: 120 });
const wtx = await until("withdrawal signed", 2, async () => {
  const t = await view<{ txid: string; raw: string | null; fee: string } | null>(C, "get_btc_tx", { owner, index: VAULT_WITHDRAWAL });
  return t?.raw ? t : null;
});
log("withdrawal signed by the MPC network", { txid: wtx.txid, fee: wtx.fee });
await until("withdrawal confirms", 90, async () => {
  await engine.tick();
  const w = await view<Transfer | null>(C, "get_vault_withdrawal", { owner });
  assert(w?.state !== "Failed", `withdrawal failed: ${w?.failure}`);
  return w?.state === "Confirmed";
});
const change = FUND - WITHDRAW - Number(wtx.fee);
const vaultCoin = await until("change is spendable", 5, async () => (await coins(vault.address)).find((u) => u.txid === wtx.txid && u.status.confirmed));
assert(vaultCoin.value === change, `change back to the vault (${vaultCoin.value} vs ${change})`);
log("owner withdrawal confirmed; change back in the vault", { withdrawn: WITHDRAW, fee: wtx.fee, change });

// ------------------------------------------- 2. propose with the vault coin
await waitChain(owner, (await plan(owner)).overdue_at_ms);
await call(G1, C, "propose_release", { owner, btc_utxos: [{ txid: vaultCoin.txid, vout: vaultCoin.vout, value: String(vaultCoin.value) }] });
const id = (await plan(owner)).plan.proposal!.id;
await call(G2, C, "approve_release", { owner, proposal_id: id });
const rel = await view<{ reserve: string }>(C, "get_btc_release", { owner });
const ts = (await plan(owner)).plan.proposal!.transfers;
const ia = ts.findIndex((t) => t.asset === "Btc" && t.heir === AMARA);
const it = ts.findIndex((t) => t.asset === "Btc" && t.heir === TOBI);
const amt = { amara: Number(ts[ia]!.amount), tobi: Number(ts[it]!.amount) };
// shares round down; the leftover sats (under one per heir) stay in the vault
const split = change - Number(rel.reserve);
assert(amt.amara + amt.tobi <= split && split - (amt.amara + amt.tobi) < 2, "everything but the fee reserve and rounding is split");
assert(amt.amara === Math.floor(((change - Number(rel.reserve)) * 6000) / 10_000) || amt.amara === Math.ceil(((change - Number(rel.reserve)) * 6000) / 10_000), "60/40");
log("snapshot", { reserve: rel.reserve, ...amt });

// ------------------------------------------------- 3. claim, chain, settle
await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);
await call(AMARA, C, "claim", { owner }, { tgas: 300 });
await call(TOBI, C, "claim", { owner }, { tgas: 300 });
const ta = await until("Amara's payout signed", 2, () => view<{ txid: string; raw: string | null; inputs: { txid: string }[] }>(C, "get_btc_tx", { owner, index: ia }).then((t) => (t.raw ? t : null)));
const tt = await until("Tobi's payout signed", 2, () => view<{ txid: string; raw: string | null; inputs: { txid: string }[] }>(C, "get_btc_tx", { owner, index: it }).then((t) => (t.raw ? t : null)));
assert(tt.inputs[0]!.txid === ta.txid, "Tobi's payout spends Amara's change");
log("both payouts signed, chained", { amara: ta.txid, tobi: tt.txid });
await until("both payouts in the mempool", 10, async () => {
  await engine.tick();
  const p = await plan(owner);
  return [ia, it].every((i) => ["Broadcast", "Confirmed"].includes(p.plan.proposal!.transfers[i]!.state));
});
assert((await received(amaraBtc)) === amt.amara, "Amara's Taproot address got exactly her share");
assert((await received(tobiBtc)) === amt.tobi, "Tobi's address got exactly his share");
log("heirs' addresses hold their shares (mempool)", { amara: `${ESPLORA.replace("/api", "")}/tx/${ta.txid}` });
await until("payouts confirm and the plan settles", 90, async () => {
  await engine.tick();
  const p = await plan(owner);
  assert(!p.plan.proposal?.transfers.some((t) => t.state === "Failed"), "no payout failed");
  return p.status === "Settled";
});
log("settled", { amara: ta.txid, tobi: tt.txid });

console.log("✓ Bitcoin vault: owner withdrawal, fee-reserved split, chained payouts to bech32 and bech32m heirs, settled");
