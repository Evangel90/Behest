// Admin tool: re-issue ETH transfers whose transaction was mined but reverted.
// Usage: pnpm --filter @behest/testnet reissue <owner> [--run]
//
// D22: `reissue_reverted_transfer` needs a proof of the revert, checked by the
// contract against the Ethereum light client on NEAR. This tool builds that
// proof from a Sepolia node once the light client holds the block as final,
// submits it (any account may; the admin key is just convenient here), then
// re-issues. Transfers are re-issued in nonce order so new nonces keep it.
// --run then drives the executor to confirmation, checks each heir's balance
// and sweeps generated heir wallets back to the funder.
import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { call, loadDeployment, log, provider, view } from "./near.js";
import { createEthPort } from "@behest/executor/eth";
import { executor, funderAccount, loadWallets, pub, sweep, vaultOf } from "./sepolia.js";

interface Transfer { heir: string; asset: string; destination: string; amount: string; state: string; failure: string | null; tx_hash: string | null; eth_tx: { nonce: number; gas_limit: number } | null }
interface PlanView { status: string; plan: { proposal: { transfers: Transfer[] } | null } }

const owner = process.argv[2];
if (!owner) throw new Error("usage: reissue <owner> [--run]");
const d = loadDeployment();
const C = d.contract;
const transfers = async () => (await view<PlanView>(C, "get_plan", { owner })).plan.proposal?.transfers ?? [];

const candidates = (await transfers())
  .map((t, index) => ({ t, index }))
  .filter(({ t }) => t.asset === "Eth" && t.state === "Failed" && t.failure === "Reverted")
  .sort((a, b) => (a.t.eth_tx?.nonce ?? 0) - (b.t.eth_tx?.nonce ?? 0));

for (const { t, index } of candidates) {
  const receipt = t.tx_hash ? await pub.getTransactionReceipt({ hash: t.tx_hash as Hex }).catch(() => null) : null;
  if (receipt?.status !== "reverted") {
    log("skipping: not verifiably reverted on Sepolia", { index, tx: t.tx_hash, status: receipt?.status ?? "not found" });
    continue;
  }
  const proven = await view<string | null>(C, "get_revert_proof", { owner, index });
  if (proven?.toLowerCase() !== t.tx_hash!.toLowerCase()) {
    const lc = (await view<{ eth_light_client: string | null }>(C, "get_config")).eth_light_client;
    if (!lc) throw new Error("no Ethereum light client configured (set_eth_light_client)");
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(receipt.blockNumber);
    const fin = (await provider.query({ request_type: "call_function", finality: "final", account_id: lc, method_name: "block_hash_safe", args_base64: n.toString("base64") } as never)) as unknown as { result: number[] };
    if (fin.result[0] !== 1) {
      log("waiting: the light client hasn't finalized the block yet; run again later", { index, block: Number(receipt.blockNumber) });
      continue;
    }
    const proof = await createEthPort(process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com").outcomeProof!(t.tx_hash as Hex);
    await call(d.admin, C, "prove_eth_outcome", { owner, index, proof }, { tgas: 150 });
    log("revert proven", { index, tx: t.tx_hash });
  }
  await call(d.admin, C, "reissue_reverted_transfer", { owner, index }, { tgas: 300 });
  log("re-issued", { index, heir: t.heir, oldNonce: t.eth_tx?.nonce, revertedTx: t.tx_hash });
}

if (process.argv.includes("--run")) {
  const deadline = Date.now() + 5 * 60_000;
  let eth = (await transfers()).filter((t) => t.asset === "Eth");
  while (eth.some((t) => t.state === "Signing")) {
    if (Date.now() > deadline) throw new Error("MPC signing too slow");
    await new Promise((r) => setTimeout(r, 4_000));
    eth = (await transfers()).filter((t) => t.asset === "Eth");
  }
  log("signed", eth.map((t) => ({ heir: t.heir, nonce: t.eth_tx?.nonce, gas: t.eth_tx?.gas_limit, state: t.state })));

  const engine = executor(C, d.executor);
  const end = Date.now() + 10 * 60_000;
  while (!eth.every((t) => t.state === "Confirmed")) {
    if (Date.now() > end) throw new Error(`not confirmed: ${eth.map((t) => `${t.state}/${t.failure}`).join(",")}`);
    await engine.tick();
    await new Promise((r) => setTimeout(r, 8_000));
    eth = (await transfers()).filter((t) => t.asset === "Eth");
  }
  for (const t of eth) log("confirmed", { heir: t.heir, nonce: t.eth_tx?.nonce, explorer: `https://sepolia.etherscan.io/tx/${t.tx_hash}` });

  for (const t of eth) {
    const got = await pub.getBalance({ address: t.destination as Hex });
    if (got !== BigInt(t.amount)) throw new Error(`${t.heir} has ${got}, expected ${t.amount}`);
  }
  log("each heir received exactly its share");

  const keys = loadWallets()[owner];
  if (keys) {
    const to = funderAccount().address;
    const swept = (await sweep(keys.amara, to)) + (await sweep(keys.tobi, to));
    log("test ETH swept back to funder", { eth: formatEther(swept), heirs: [keys.amara, keys.tobi].map((k) => privateKeyToAccount(k).address) });
  }
  log("vault residual", { eth: formatEther(await pub.getBalance({ address: await vaultOf(C, owner) })) });
  console.log("✓ reverted transfers recovered");
}
