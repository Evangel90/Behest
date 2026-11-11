// Live Stage 2 demo: partial failure and retry across two assets, without
// replaying the transfer that already succeeded.
//
// Amara is the only ETH heir. The vault holds 0.008 ETH and 0.0005 WETH, but
// the proposing guardian reports 0.002 WETH (an over-report, threat 22), so
// Amara's WETH share can't be paid yet:
//   1. Amara claims: ETH (nonce 0) and WETH (nonce 1) are MPC-signed.
//   2. The executor sends the ETH. Its simulation of the WETH transfer reverts,
//      so it reports WouldRevert without broadcasting: no fee spent, nonce 1 unused.
//   3. The vault is topped up; Amara retries. The contract re-signs WETH at
//      the same nonce. The confirmed ETH transfer isn't touched or re-signed.
//   4. Both confirm; Amara holds exactly one ETH share and one WETH share.
// Usage: pnpm --filter @behest/testnet e2e-partial
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { createWalletClient, erc20Abi, formatEther, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { account, call, loadDeployment, log, reclaimScenarioOwners, view, waitForKey, payTier } from "./near.js";
import { ensureScenarioFunds } from "./funding.js";
import { WETH, executor, funderAccount, pub, reclaimVault, saveWallets, tokenBalance, transport, vaultOf } from "./sepolia.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
// Fresh scenario owners come out of the owner parent: top up first, never fail half way.
await ensureScenarioFunds(d, 0.45);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
// Reserve: 1 ETH heir × (ETH + WETH) × 250k gas × 3 gwei = 0.0015 ETH; 0.00005 ETH
// is split. Amara's WETH share of the reported 0.00002 is 0.000012 > 0.000005 held.
// The unspent reserve is withdrawn back to the funder at the end (D7).
const FUND_ETH = parseEther("0.00155");
const VAULT_WETH = parseEther("0.000005");
const REPORTED_WETH = parseEther("0.00002");
const TOP_UP_WETH = parseEther("0.00001");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: "Near" | "Eth" | { Erc20: string }; amount: string; state: string; tx_hash: string | null; failure: string | null; attempts: number; eth_tx: { nonce: number } | null; signed_versions: unknown[] }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const isWeth = (t: Transfer) => typeof t.asset === "object" && t.asset.Erc20 === WETH;
async function amaraEvm(owner: string) {
  const ts = (await plan(owner)).plan.proposal!.transfers;
  const i = { eth: ts.findIndex((t) => t.heir === AMARA && t.asset === "Eth"), weth: ts.findIndex((t) => t.heir === AMARA && isWeth(t)) };
  return { i, eth: ts[i.eth]!, weth: ts[i.weth]! };
}
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}
async function until(what: string, ms: number, check: () => Promise<boolean>, tick?: () => Promise<unknown>) {
  const end = Date.now() + ms;
  for (;;) {
    await tick?.();
    if (await check()) return;
    assert(Date.now() < end, `timed out: ${what}`);
    await sleep(6_000);
  }
}

const funder = funderAccount();
const fund = createWalletClient({ chain: sepolia, transport, account: funder });
async function sendWeth(to: Hex, amount: bigint) {
  await pub.waitForTransactionReceipt({ hash: await fund.sendTransaction({ to: WETH, value: amount }) });
  const hash = await fund.writeContract({ address: WETH, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
const funderStart = await pub.getBalance({ address: funder.address });
assert(funderStart > FUND_ETH + VAULT_WETH + TOP_UP_WETH + parseEther("0.0005"), `funder has ${formatEther(funderStart)} ETH; needs ≈ 0.0021`);

// ------------------------------------------------------------------ setup
const keys = { amara: generatePrivateKey(), tobi: generatePrivateKey() };
const amaraAddr = privateKeyToAccount(keys.amara).address;
const kp = KeyPair.fromRandom("ed25519");
const sub = `part${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.45") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
saveWallets(owner, keys);

await payTier(C, owner, 2, d.admin);
await call(owner, C, "set_plan", {
  plan: {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: d.guardians,
    quorum: 2,
    heirs: [
      { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: amaraAddr.toLowerCase() },
      { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null },
    ],
  },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "deposit", { owner }, { deposit: nearToYocto("0.3") });
const vault = await vaultOf(C, owner);
await pub.waitForTransactionReceipt({ hash: await fund.sendTransaction({ to: vault, value: FUND_ETH }) });
await sendWeth(vault, VAULT_WETH);
log("vault funded", { owner, vault, eth: formatEther(await pub.getBalance({ address: vault })), weth: formatEther(await tokenBalance(WETH, vault)) });

await waitChain(owner, (await plan(owner)).overdue_at_ms);
const ethBal = await pub.getBalance({ address: vault });
await call(G1, C, "propose_release", { owner, eth_balance: ethBal.toString(), erc20_balances: [{ token: WETH, amount: REPORTED_WETH.toString() }] });
log("guardian over-reported the vault's WETH", { actual: formatEther(VAULT_WETH), reported: formatEther(REPORTED_WETH) });
await call(G2, C, "approve_release", { owner, proposal_id: (await plan(owner)).plan.proposal!.id });
await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);

// ------------------------------------------------- 1. claim and MPC signing
await call(AMARA, C, "claim", { owner }, { tgas: 300 });
await call(TOBI, C, "claim", { owner }, { tgas: 100 });
await until("MPC signatures", 5 * MINUTE, async () => {
  const a = await amaraEvm(owner);
  return a.eth.state === "Signed" && a.weth.state === "Signed";
});
let a = await amaraEvm(owner);
assert(a.eth.eth_tx!.nonce === 0 && a.weth.eth_tx!.nonce === 1, "ETH nonce 0, WETH nonce 1");
log("signed", { ethNonce: 0, wethNonce: 1, wethShare: formatEther(BigInt(a.weth.amount)) });

// -------------------------------------- 2. ETH lands, WETH caught pre-broadcast
const engine = executor(C, d.executor);
await until("ETH confirmed and WETH WouldRevert", 10 * MINUTE, async () => {
  a = await amaraEvm(owner);
  return a.eth.state === "Confirmed" && a.weth.state === "Failed";
}, () => engine.tick());
assert(a.weth.failure === "WouldRevert", `WETH failure is ${a.weth.failure}`);
assert(a.weth.tx_hash === null, "WETH was never broadcast");
assert((await pub.getTransactionCount({ address: vault })) === 1, "vault used only nonce 0");
assert((await tokenBalance(WETH, vault)) === VAULT_WETH, "vault WETH untouched");
const ethDone = { hash: a.eth.tx_hash, attempts: a.eth.attempts, versions: a.eth.signed_versions.length };
log("partial failure", { eth: `Confirmed ${ethDone.hash}`, weth: "Failed(WouldRevert), not broadcast, nonce 1 still free" });

// -------------------------------------------- 3. top up, heir retries WETH
log("vault topped up", { tx: await sendWeth(vault, TOP_UP_WETH), weth: formatEther(await tokenBalance(WETH, vault)) });
await call(AMARA, C, "retry_transfer", { owner, index: a.i.weth }, { tgas: 300 });
await until("WETH re-signed", 5 * MINUTE, async () => (await amaraEvm(owner)).weth.state === "Signed");
a = await amaraEvm(owner);
assert(a.weth.eth_tx!.nonce === 1 && a.weth.attempts === 2, "re-signed at the same nonce (attempt 2)");

// --------------------------------------------------------- 4. both settled
await until("WETH confirmed", 10 * MINUTE, async () => {
  a = await amaraEvm(owner);
  return a.weth.state === "Confirmed";
}, () => engine.tick());
assert(a.eth.tx_hash === ethDone.hash && a.eth.attempts === ethDone.attempts && a.eth.signed_versions.length === ethDone.versions, "the confirmed ETH transfer was not touched or re-signed");
assert((await pub.getTransactionCount({ address: vault })) === 2, "vault sent exactly two transactions");
const gotEth = await pub.getBalance({ address: amaraAddr });
const gotWeth = await tokenBalance(WETH, amaraAddr);
assert(gotEth === BigInt(a.eth.amount), `Amara holds ${gotEth} wei, expected exactly one share ${a.eth.amount}`);
assert(gotWeth === BigInt(a.weth.amount), `Amara holds ${gotWeth} WETH units, expected ${a.weth.amount}`);
await until("plan settled", 2 * MINUTE, async () => (await plan(owner)).status === "Settled");
log("confirmed", { eth: `https://sepolia.etherscan.io/tx/${a.eth.tx_hash}`, weth: `https://sepolia.etherscan.io/tx/${a.weth.tx_hash}`, amara: `${formatEther(gotEth)} ETH + ${formatEther(gotWeth)} WETH` });

log("vault reclaimed by owner withdrawal", await reclaimVault(C, owner, vault, engine, funder.address));
log("leftovers", { vaultEth: formatEther(await pub.getBalance({ address: vault })), vaultWeth: formatEther(await tokenBalance(WETH, vault)) });
console.log("✓ partial failure across two assets, retried without replaying the confirmed transfer");
