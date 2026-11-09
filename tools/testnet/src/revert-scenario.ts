// Live D22 demo (threat 20): a reverted Sepolia transfer is re-issued only
// after the contract has checked a proof of the revert against the Ethereum
// light client on NEAR. Nobody's word is trusted, not even the admin's.
//
//   1. The admin lowers the gas limit to 21k for one proposal. Sending ETH to a
//      never-used address now costs ~207k gas, so Amara's transfer reverts
//      when mined (the scenario broadcasts it past the executor's guard).
//   2. The executor reports "Reverted". The admin tries to re-issue: refused,
//      the revert isn't proven.
//   3. The executor waits until the light client finalizes the block, builds
//      the header + Merkle-Patricia proofs, and the contract verifies them.
//   4. The executor re-issues under the next nonce with the restored 250k
//      limit, and Amara receives exactly her share.
// Usage: pnpm --filter @behest/testnet e2e-revert
//
// E2E_RESUME_OWNER=<owner> E2E_REVERTED_TX=<hash> resumes a run whose revert
// was recorded wrongly: another executor saw the 21k transfer, refused it
// ("GasLimitTooLow") and believed nonce 0 unused, while the scenario had
// already broadcast it. Then Amara (an heir, not the executor) submits the
// proof, which corrects the record and unlocks the re-issue.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { createWalletClient, formatEther, keccak256, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { account, call, loadDeployment, log, reclaimScenarioOwners, view, waitForKey } from "./near.js";
import { createEthPort } from "@behest/executor/eth";
import { executor, funderAccount, loadWallets, pub, reclaimVault, saveWallets, sweep, transport, vaultOf } from "./sepolia.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const [G1, G2] = d.guardians as [string, string];
const [AMARA] = d.heirs as [string];
const MINUTE = 60_000;
// The re-issue signs 250k gas at up to 2 gwei (0.0005 ETH) on top of the
// share, so the vault holds more than the guardian reports for the split.
const FUND = parseEther("0.0008");
const REPORTED = parseEther("0.0002");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
interface Transfer { heir: string; asset: unknown; amount: string; state: string; tx_hash: string | null; failure: string | null; eth_tx: { nonce: number; gas_limit: number } | null }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}
const ethOf = async (owner: string) => {
  const ts = (await plan(owner)).plan.proposal!.transfers;
  const index = ts.findIndex((t) => t.asset === "Eth");
  return { index, t: ts[index]! };
};

const funder = funderAccount();
const fundWallet = createWalletClient({ chain: sepolia, transport, account: funder });

const resumeOwner = process.env.E2E_RESUME_OWNER?.trim();
let owner: string, vault: Hex, amaraKey: Hex, amaraAddr: Hex, oldNonce: number, bad: Hex, heirProves = false;
const engine = executor(C, d.executor);
const cfg = await view<{ eth_gas_limit: number }>(C, "get_config");
let e: Awaited<ReturnType<typeof ethOf>>;

if (resumeOwner) {
  owner = resumeOwner;
  amaraKey = loadWallets()[owner]!.amara as Hex;
  amaraAddr = privateKeyToAccount(amaraKey).address;
  vault = await vaultOf(C, owner);
  bad = process.env.E2E_REVERTED_TX!.trim() as Hex;
  e = await ethOf(owner);
  oldNonce = e.t.eth_tx!.nonce;
  const r = await pub.getTransactionReceipt({ hash: bad });
  assert(r.status === "reverted", "the resumed transaction reverted");
  log("resuming", { owner, recorded: `${e.t.state}/${e.t.failure}`, reverted: bad, block: Number(r.blockNumber) });
  const refused = await call(d.admin, C, "reissue_reverted_transfer", { owner, index: e.index }, { tgas: 300 }).then(() => "accepted", (x) => String(x));
  assert(refused.includes("E_INVALID_TRANSFER_STATE") || refused.includes("E_REVERT_NOT_PROVEN"), "admin can't re-issue without a proof");
  heirProves = true;
} else {
  // ------------------------------------------------------------------ setup
  amaraKey = generatePrivateKey();
  amaraAddr = privateKeyToAccount(amaraKey).address;
  const kp = KeyPair.fromRandom("ed25519");
  const sub = `rvt${Date.now().toString(36)}`;
  owner = `${sub}.${d.owner}`;
  await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.2") });
  await waitForKey(owner, kp.getPublicKey().toString());
  const dir = join(homedir(), ".near-credentials/testnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  saveWallets(owner, { amara: amaraKey, tobi: amaraKey });

  await call(owner, C, "set_plan", {
    plan: {
      check_in_interval_ms: MINUTE,
      grace_ms: 0,
      waiting_period_ms: MINUTE,
      guardians: d.guardians,
      quorum: 2,
      heirs: [{ account_id: AMARA, share_bps: 10_000, near_destination: AMARA, eth_destination: amaraAddr.toLowerCase() }],
    },
  }, { deposit: nearToYocto("0.05") });
  await call(owner, C, "deposit", { owner }, { deposit: nearToYocto("0.05") });
  vault = await vaultOf(C, owner);
  const fundTx = await fundWallet.sendTransaction({ to: vault, value: FUND });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  log("plan with a fresh ETH heir", { owner, vault, amara: amaraAddr, funded: formatEther(FUND) });

  // --------------------------------------- 1. a proposal with a 21k gas limit
  await waitChain(owner, (await plan(owner)).overdue_at_ms);
  await call(d.admin, C, "set_eth_gas_limit", { gas_limit: 21_000 });
  try {
    await call(G1, C, "propose_release", { owner, eth_balance: REPORTED.toString(), erc20_balances: [] });
  } finally {
    await call(d.admin, C, "set_eth_gas_limit", { gas_limit: cfg.eth_gas_limit });
  }
  await call(G2, C, "approve_release", { owner, proposal_id: (await plan(owner)).plan.proposal!.id });
  await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);
  await call(AMARA, C, "claim", { owner }, { tgas: 300 });
  e = await ethOf(owner);
  for (const end = Date.now() + 5 * MINUTE; e.t.state !== "Signed"; e = await ethOf(owner)) {
    assert(Date.now() < end && e.t.state !== "Failed", `signing: ${e.t.state} ${e.t.failure ?? ""}`);
    await sleep(4_000);
  }
  assert(e.t.eth_tx!.gas_limit === 21_000, `signed with 21k gas (got ${e.t.eth_tx!.gas_limit})`);
  oldNonce = e.t.eth_tx!.nonce;

  // The executor would refuse this (signed limit below the estimate); send it
  // directly, recording the broadcast first so no other executor intervenes.
  const raw = (await view<string>(C, "get_signed_tx", { owner, index: e.index })) as Hex;
  await call(d.executor, C, "report_broadcast", { owner, index: e.index, tx_hash: keccak256(raw) });
  bad = await pub.sendRawTransaction({ serializedTransaction: raw });
  const badReceipt = await pub.waitForTransactionReceipt({ hash: bad });
  assert(badReceipt.status === "reverted", `expected a revert, got ${badReceipt.status}`);
  log("transfer reverted on Sepolia", { tx: `https://sepolia.etherscan.io/tx/${bad}`, block: Number(badReceipt.blockNumber), gasUsed: Number(badReceipt.gasUsed) });

  // ---------------------------------- 2. a "Reverted" report isn't enough
  await engine.tick();
  e = await ethOf(owner);
  assert(e.t.state === "Failed" && e.t.failure === "Reverted", `executor reported the revert (${e.t.state}/${e.t.failure})`);
  const refused = await call(d.admin, C, "reissue_reverted_transfer", { owner, index: e.index }, { tgas: 300 }).then(() => "accepted", (x) => String(x));
  assert(refused.includes("E_REVERT_NOT_PROVEN"), `admin re-issue without a proof is refused (${refused.slice(0, 120)})`);
  log("re-issue on the admin's word refused", { error: "E_REVERT_NOT_PROVEN" });

}

// ------------------------- 3 + 4. light-client finality, proof, re-issue
const started = Date.now();
let provenAt: number | null = null;
async function lightClientFinal(n: bigint) {
  const lc = (await view<{ eth_light_client: string | null }>(C, "get_config")).eth_light_client!;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  const r = await fetch(process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: lc, method_name: "block_hash_safe", args_base64: b.toString("base64") } }) });
  return ((await r.json()) as { result: { result: number[] } }).result.result[0] === 1;
}
const eth = createEthPort(process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com");
for (const end = Date.now() + 75 * MINUTE; ; ) {
  if (heirProves && !provenAt) {
    const blk = (await pub.getTransactionReceipt({ hash: bad })).blockNumber;
    if (await lightClientFinal(blk)) {
      await call(AMARA, C, "prove_eth_outcome", { owner, index: e.index, proof: await eth.outcomeProof!(bad) }, { tgas: 150 });
      log("Amara submitted the proof");
    }
  }
  await engine.tick();
  e = await ethOf(owner);
  const proof = await view<string | null>(C, "get_revert_proof", { owner, index: e.index });
  if (!provenAt && (proof || (e.t.eth_tx && e.t.eth_tx.nonce !== oldNonce))) {
    provenAt = Date.now();
    log("revert proven against the light client", { after: `${Math.round((provenAt - started) / 60_000)} min`, tx: proof ?? bad });
  }
  if (e.t.state === "Confirmed") break;
  assert(Date.now() < end, `not done in time: ${e.t.state}/${e.t.failure ?? ""}`);
  await sleep(provenAt ? 10_000 : 60_000);
}
assert(e.t.eth_tx!.nonce > oldNonce && e.t.eth_tx!.gas_limit >= cfg.eth_gas_limit, `re-issued under a new nonce with ${cfg.eth_gas_limit} gas`);
const got = await pub.getBalance({ address: amaraAddr });
assert(got === BigInt(e.t.amount), `Amara received ${got}, expected ${e.t.amount}`);
log("re-issued and confirmed", { nonce: `${oldNonce} → ${e.t.eth_tx!.nonce}`, tx: `https://sepolia.etherscan.io/tx/${e.t.tx_hash}`, amara: formatEther(got) });
assert((await plan(owner)).status === "Settled", "plan settled");

log("vault reclaimed by owner withdrawal", await reclaimVault(C, owner, vault, engine, funder.address));
log("heir swept", { eth: formatEther(await sweep(amaraKey, funder.address)) });
console.log("✓ a reverted transfer was re-issued only after a light-client-checked proof of the revert");
