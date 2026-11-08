// Live ETH leg: Chain Signatures → executor → Sepolia, with a deliberately
// delayed executor. Usage: pnpm --filter @behest/testnet e2e-eth
//
// Amara's ETH destination is the funder wallet itself, so test ETH returns home.
// E2E_RESUME_OWNER=<owner> resumes an earlier run that is already Eligible
// (reuses its funded vault instead of creating and funding a new plan).
import { Engine } from "@behest/executor/engine";
import { createEthPort } from "@behest/executor/eth";
import { createNearPort, ethAddressFromMpcKey } from "@behest/executor/near";
import { memoryStore } from "@behest/executor/store";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto, type KeyPairString } from "near-api-js";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { account, call, loadDeployment, log, provider, view } from "./near.js";

const d = loadDeployment();
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const FUND = parseEther(process.env.E2E_VAULT_FUND_ETH ?? "0.01");

const rawKey = (process.env.SEPOLIA_FUNDER_KEY ?? "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error("SEPOLIA_FUNDER_KEY must be a 32-byte hex private key (not an address)");
const funder = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);
const transport = http(process.env.SEPOLIA_RPC_URL?.trim() || undefined);
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account: funder });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: "Near" | "Eth"; amount: string; state: string; tx_hash: string | null; failure: string | null }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });

async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}

async function waitEth(owner: string, want: string[], timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = (await plan(owner)).plan.proposal!.transfers.find((x) => x.asset === "Eth")!;
    if (want.includes(t.state)) return t;
    if (Date.now() > end) throw new Error(`ETH transfer stuck in ${t.state} (${t.failure ?? ""})`);
    await sleep(4_000);
  }
}

// --- 0. preflight
const funderBal = await pub.getBalance({ address: funder.address });
log("funder", { address: funder.address, balanceEth: formatEther(funderBal) });
assert(funderBal > FUND + parseEther("0.002"), `funder needs > ${formatEther(FUND)} ETH plus gas`);

// --- 1. fresh owner and plan with an ETH heir
async function setup(): Promise<{ owner: string; vault: Hex; vaultBal: bigint }> {
const kp = KeyPair.fromRandom("ed25519");
const sub = `eth${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.6") });
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });

await call(owner, C, "set_plan", {
  plan: {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: d.guardians,
    quorum: 2,
    heirs: [
      { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: funder.address.toLowerCase() },
      { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null },
    ],
  },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "deposit", { owner }, { deposit: nearToYocto("0.3") });

// --- 2. derive and fund the plan's Sepolia vault
const mpcKey = (await provider.callFunction({
  contractId: process.env.MPC_CONTRACT_ID || "v1.signer-prod.testnet",
  method: "derived_public_key",
  args: { path: await view<string>(C, "get_eth_vault_path", { owner }), predecessor: C, domain_id: 0 },
})) as string;
const vault = ethAddressFromMpcKey(mpcKey);
log("plan created", { owner, vault });
const fundTx = await wallet.sendTransaction({ to: vault, value: FUND });
await pub.waitForTransactionReceipt({ hash: fundTx });
const vaultBal = await pub.getBalance({ address: vault });
log("vault funded", { tx: fundTx, vaultEth: formatEther(vaultBal) });

// --- 3. owner goes silent; guardians propose with the observed balance and approve
await waitChain(owner, (await plan(owner)).overdue_at_ms);
await call(G1, C, "propose_release", { owner, eth_balance: vaultBal.toString() });
await call(G2, C, "approve_release", { owner, proposal_id: (await plan(owner)).plan.proposal!.id });
await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);
log("eligible");
return { owner, vault, vaultBal };
}

async function resume(owner: string): Promise<{ owner: string; vault: Hex; vaultBal: bigint }> {
  const key = (await provider.callFunction({
    contractId: process.env.MPC_CONTRACT_ID || "v1.signer-prod.testnet",
    method: "derived_public_key",
    args: { path: await view<string>(C, "get_eth_vault_path", { owner }), predecessor: C, domain_id: 0 },
  })) as string;
  const vault = ethAddressFromMpcKey(key);
  const p = await plan(owner);
  assert(p.status === "Eligible", `resume needs an Eligible plan, got ${p.status}`);
  const vaultBal = await pub.getBalance({ address: vault });
  log("resuming", { owner, vault, vaultEth: formatEther(vaultBal) });
  return { owner, vault, vaultBal };
}

const resumeOwner = process.env.E2E_RESUME_OWNER?.trim();
const { owner, vault, vaultBal } = resumeOwner ? await resume(resumeOwner) : await setup();

// --- 4. heir claims: contract requests an MPC signature for the exact transfer
const before = await pub.getBalance({ address: funder.address });
await call(AMARA, C, "claim", { owner }, { tgas: 300 });
await call(TOBI, C, "claim", { owner }, { tgas: 100 });
const signed = await waitEth(owner, ["Signed", "Failed"], 5 * MINUTE);
assert(signed.state === "Signed", `MPC signing failed: ${signed.failure}`);
log("MPC signature stored on-chain", { amountWei: signed.amount });

// --- 5. delayed executor: nothing moves, nothing is lost
log("executor offline for 60s (delayed-executor demo)");
await sleep(MINUTE);
const idle = await waitEth(owner, ["Signed"], 1_000);
assert(idle.state === "Signed", "transfer waits safely while no executor runs");
assert((await pub.getBalance({ address: vault })) === vaultBal, "vault untouched while executor is down");

// --- 6. executor comes back
const engine = new Engine(
  createNearPort({
    rpcUrl: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com",
    contractId: C,
    executorAccountId: d.executor,
    executorPrivateKey: process.env.EXECUTOR_PRIVATE_KEY as KeyPairString,
  }),
  createEthPort(process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com"),
  memoryStore(),
  { confirmations: 3, stuckAfterMs: 10 * MINUTE, retryBackoffMs: MINUTE, now: Date.now, log: (m, x) => log(`executor: ${m}`, x) },
);
const end = Date.now() + 10 * MINUTE;
for (;;) {
  await engine.tick();
  const t = (await plan(owner)).plan.proposal!.transfers.find((x) => x.asset === "Eth")!;
  if (t.state === "Confirmed") {
    log("confirmed on Sepolia", { tx: t.tx_hash, explorer: `https://sepolia.etherscan.io/tx/${t.tx_hash}` });
    break;
  }
  if (Date.now() > end) throw new Error(`not confirmed in time: ${t.state} ${t.failure ?? ""}`);
  await sleep(10_000);
}

// --- 7. verify receipt at the fixed destination and plan settlement
const after = await pub.getBalance({ address: funder.address });
assert(after - before === BigInt(signed.amount), "destination received exactly the snapshot amount");
const final = await plan(owner);
log("done", { status: final.status, received: formatEther(after - before), leftInVault: formatEther(await pub.getBalance({ address: vault })) });
assert(final.status === "Settled", "plan settled");
console.log("✓ happy-eth + delayed-executor");
