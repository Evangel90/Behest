// Live ETH leg with two ETH heirs: Chain Signatures → executor → Sepolia.
// Usage: pnpm --filter @behest/testnet e2e-eth
//
// - Each run generates fresh Sepolia wallets for Amara and Tobi (keys kept in
//   the gitignored .testnet-wallets.json) and checks each balance on its own.
// - Tobi claims first, so his transfer gets vault nonce 0 and Amara's nonce 1;
//   the executor must wait for nonce 0 before broadcasting nonce 1.
// - The executor is offline for 60 s after signing (delayed-executor demo).
// - Afterwards all test ETH in the heir wallets is swept back to the funder.
//
// E2E_RESUME_OWNER=<owner> resumes an earlier run that is already Eligible.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { erc20Abi, createWalletClient, formatEther, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { account, call, loadDeployment, log, view, reclaimScenarioOwners, waitForKey, payTier } from "./near.js";
import { WETH, executor, funderAccount, loadWallets, pub, reclaimVault, saveWallets, sweep, tokenBalance, transport, vaultOf as vaultFor } from "./sepolia.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
// The fee reserve covers one max-fee tx per vault transfer: 2 heirs × (ETH + WETH)
// × 250k gas × 3 gwei = 0.003 ETH. Only 0.00005 ETH and 0.00001 WETH are split;
// the unspent reserve is withdrawn back to the funder at the end (D7).
const FUND = parseEther(process.env.E2E_VAULT_FUND_ETH ?? "0.00305");
const FUND_WETH = parseEther(process.env.E2E_VAULT_FUND_WETH ?? "0.00001");

const funder = funderAccount();
const fundWallet = createWalletClient({ chain: sepolia, transport, account: funder });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: "Near" | "Eth" | { Erc20: string }; destination: string; amount: string; state: string; tx_hash: string | null; failure: string | null; eth_tx: { nonce: number; gas_limit: number } | null }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
// Every vault transfer: ETH and WETH.
const ethTransfers = async (owner: string) => (await plan(owner)).plan.proposal!.transfers.filter((t) => t.asset !== "Near");
const isWeth = (t: Transfer) => typeof t.asset === "object" && t.asset.Erc20 === WETH;
const vaultOf = (owner: string) => vaultFor(C, owner);

// ------------------------------------------------------------------ setup

async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}

async function setup() {
  const keys = { amara: generatePrivateKey(), tobi: generatePrivateKey() };
  const addr = { amara: privateKeyToAccount(keys.amara).address, tobi: privateKeyToAccount(keys.tobi).address };

  const kp = KeyPair.fromRandom("ed25519");
  const sub = `eth${Date.now().toString(36)}`;
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
        { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: addr.amara.toLowerCase() },
        { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: addr.tobi.toLowerCase() },
      ],
    },
  }, { deposit: nearToYocto("0.05") });
  await call(owner, C, "deposit", { owner }, { deposit: nearToYocto("0.3") });

  const vault = await vaultOf(owner);
  log("plan created", { owner, vault, amaraEth: addr.amara, tobiEth: addr.tobi });
  const fundTx = await fundWallet.sendTransaction({ to: vault, value: FUND });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  // Wrap ETH into WETH (WETH mints on plain ETH sends) and move it to the vault.
  const wrapTx = await fundWallet.sendTransaction({ to: WETH, value: FUND_WETH });
  await pub.waitForTransactionReceipt({ hash: wrapTx });
  const moveTx = await fundWallet.writeContract({ address: WETH, abi: erc20Abi, functionName: "transfer", args: [vault, FUND_WETH] });
  await pub.waitForTransactionReceipt({ hash: moveTx });
  const vaultBal = await pub.getBalance({ address: vault });
  const vaultWeth = await tokenBalance(WETH, vault);
  log("vault funded", { tx: fundTx, wethTx: moveTx, vaultEth: formatEther(vaultBal), vaultWeth: formatEther(vaultWeth) });

  await waitChain(owner, (await plan(owner)).overdue_at_ms);
  await call(G1, C, "propose_release", { owner, eth_balance: vaultBal.toString(), erc20_balances: [{ token: WETH, amount: vaultWeth.toString() }] });
  await call(G2, C, "approve_release", { owner, proposal_id: (await plan(owner)).plan.proposal!.id });
  await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);
  log("eligible");
  return { owner, vault, vaultBal, keys };
}

async function resume(owner: string) {
  const keys = loadWallets()[owner];
  assert(keys, `no generated wallets recorded for ${owner}`);
  const p = await plan(owner);
  assert(p.status === "Eligible", `resume needs an Eligible plan, got ${p.status}`);
  const vault = await vaultOf(owner);
  const vaultBal = await pub.getBalance({ address: vault });
  log("resuming", { owner, vault, vaultEth: formatEther(vaultBal) });
  return { owner, vault, vaultBal, keys };
}

// -------------------------------------------------------------------- run

const funderStart = await pub.getBalance({ address: funder.address });
log("funder", { address: funder.address, balanceEth: formatEther(funderStart) });
assert(funderStart > FUND + FUND_WETH + parseEther("0.002"), `funder needs > ${formatEther(FUND + FUND_WETH)} ETH plus gas`);

const resumeOwner = process.env.E2E_RESUME_OWNER?.trim();
const { owner, vault, vaultBal, keys } = resumeOwner ? await resume(resumeOwner) : await setup();
const heirAddr = (k: Hex) => privateKeyToAccount(k).address;

// Tobi claims first → nonce 0; Amara second → nonce 1.
await call(TOBI, C, "claim", { owner }, { tgas: 300 });
await call(AMARA, C, "claim", { owner }, { tgas: 300 });
const deadline = Date.now() + 5 * MINUTE;
let eth = await ethTransfers(owner);
while (!eth.every((t) => ["Signed", "Failed"].includes(t.state))) {
  assert(Date.now() < deadline, `MPC signing too slow: ${eth.map((t) => t.state).join(",")}`);
  await sleep(4_000);
  eth = await ethTransfers(owner);
}
assert(eth.every((t) => t.state === "Signed"), `MPC signing failed: ${eth.map((t) => t.failure).join(",")}`);
// Claim order fixes the nonces: Tobi's ETH 0 and WETH 1, then Amara's ETH 2 and WETH 3.
const nonces = (heir: string) => eth.filter((t) => t.heir === heir).map((t) => t.eth_tx!.nonce);
assert(eth.length === 4 && eth.filter(isWeth).length === 2, `expected 2 ETH + 2 WETH transfers, got ${eth.length}`);
assert(String(nonces(TOBI)) === "0,1" && String(nonces(AMARA)) === "2,3", `nonces in claim order: tobi ${nonces(TOBI)}, amara ${nonces(AMARA)}`);
log("four transfers signed by MPC", { tobi: nonces(TOBI), amara: nonces(AMARA) });

log("executor offline for 60s (delayed-executor demo)");
await sleep(MINUTE);
assert((await ethTransfers(owner)).every((t) => t.state === "Signed"), "transfers wait safely while no executor runs");
assert((await pub.getBalance({ address: vault })) === vaultBal, "vault untouched while executor is down");

const engine = executor(C, d.executor);
const outcomes = new Set<string>();
const end = Date.now() + 10 * MINUTE;
for (;;) {
  for (const [key, o] of await engine.tick()) outcomes.add(`${key.split("#")[2]}:${o}`);
  eth = await ethTransfers(owner);
  if (eth.every((t) => t.state === "Confirmed")) break;
  assert(Date.now() < end, `not confirmed in time: ${eth.map((t) => `${t.state}/${t.failure ?? ""}`).join(",")}`);
  await sleep(8_000);
}
for (const t of eth) log("confirmed on Sepolia", { heir: t.heir, asset: isWeth(t) ? "WETH" : "ETH", nonce: t.eth_tx!.nonce, explorer: `https://sepolia.etherscan.io/tx/${t.tx_hash}` });
log("executor outcomes seen", [...outcomes]);

// Each heir wallet holds exactly its snapshot amounts (fresh wallets start at 0).
for (const [heir, key] of [[AMARA, keys.amara], [TOBI, keys.tobi]] as const) {
  const mine = eth.filter((t) => t.heir === heir);
  const gotEth = await pub.getBalance({ address: heirAddr(key) });
  const gotWeth = await tokenBalance(WETH, heirAddr(key));
  const wantEth = BigInt(mine.find((t) => t.asset === "Eth")!.amount);
  const wantWeth = BigInt(mine.find(isWeth)!.amount);
  assert(gotEth === wantEth, `${heir} received ${gotEth} wei, expected ${wantEth}`);
  assert(gotWeth === wantWeth, `${heir} received ${gotWeth} WETH units, expected ${wantWeth}`);
}
const final = await plan(owner);
assert(final.status === "Settled", "plan settled");
const shares = async (k: Hex) => `${formatEther(await pub.getBalance({ address: heirAddr(k) }))} ETH + ${formatEther(await tokenBalance(WETH, heirAddr(k)))} WETH`;
log("heirs received exact shares", { amara: await shares(keys.amara), tobi: await shares(keys.tobi) });

// The heirs' shares are dust (moving them would cost more than they're worth).
// The vault's unspent fee reserve is what matters: the owner withdraws it (D7).
log("vault reclaimed by owner withdrawal", await reclaimVault(C, owner, vault, engine, funder.address));
const swept = (await sweep(keys.amara, funder.address)) + (await sweep(keys.tobi, funder.address));
log("leftovers", { heirEthSwept: formatEther(swept), vaultEth: formatEther(await pub.getBalance({ address: vault })), vaultWeth: formatEther(await tokenBalance(WETH, vault)) });
console.log("✓ two heirs × (ETH + WETH) + nonce ordering + delayed executor");
