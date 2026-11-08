// Withdraws what earlier runs left in plan vaults back to the Sepolia funder,
// through the owner vault withdrawal (D7).
// Usage: pnpm --filter @behest/testnet recover-vaults <owner> [<owner> …]
// A plan is keyed by the owner's account name, so a scenario owner that was
// deleted by cleanup is re-created under the deployment owner to act again.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { formatEther } from "viem";
import { account, loadDeployment, log, provider, view, waitForKey } from "./near.js";
import { WETH, executor, funderAccount, pub, reclaimVault, tokenBalance, vaultOf } from "./sepolia.js";

const d = loadDeployment();
const owners = process.argv.slice(2);
if (!owners.length) throw new Error("usage: recover-vaults <owner> [<owner> …]");
const KEYS = join(homedir(), ".near-credentials/testnet");
const engine = executor(d.contract, d.executor);
const to = funderAccount().address;

// A 100 Tgas call (withdrawal + MPC sign) prepays ≈0.1 NEAR of gas.
const MIN_NEAR = nearToYocto("0.2");

async function ensureOwner(owner: string) {
  if (existsSync(join(KEYS, `${owner}.json`))) {
    const have = BigInt((await provider.viewAccount({ accountId: owner })).amount);
    if (have < MIN_NEAR) await account(d.owner).transfer({ receiverId: owner, amount: MIN_NEAR - have });
    return;
  }
  const exists = await provider.viewAccount({ accountId: owner }).then(() => true, () => false);
  if (exists) throw new Error(`${owner} exists but its key isn't in the keychain`);
  const suffix = `.${d.owner}`;
  if (!owner.endsWith(suffix)) throw new Error(`${owner} is not a sub-account of ${d.owner}`);
  const kp = KeyPair.fromRandom("ed25519");
  await account(d.owner).createSubAccount({ accountOrPrefix: owner.slice(0, -suffix.length), publicKey: kp.getPublicKey().toString(), nearToTransfer: MIN_NEAR });
  mkdirSync(KEYS, { recursive: true });
  writeFileSync(join(KEYS, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  await waitForKey(owner, kp.getPublicKey().toString());
  log("re-created owner account", owner);
}

let total = 0n;
for (const owner of owners) {
  const p = await view<{ status: string } | null>(d.contract, "get_plan", { owner });
  if (!p) {
    log("no plan", owner);
    continue;
  }
  const vault = await vaultOf(d.contract, owner);
  const [eth, weth] = await Promise.all([pub.getBalance({ address: vault }), tokenBalance(WETH, vault)]);
  log("vault", { owner, status: p.status, eth: formatEther(eth), weth: formatEther(weth) });
  if (eth === 0n && weth === 0n) continue;
  if (!["Settled", "Active", "Overdue"].includes(p.status)) {
    log("skipped: a release is open", owner);
    continue;
  }
  try {
    await ensureOwner(owner);
    const before = await pub.getBalance({ address: to });
    log("recovered", await reclaimVault(d.contract, owner, vault, engine, to));
    total += (await pub.getBalance({ address: to })) - before;
  } catch (e) {
    log("could not recover", { owner, error: String(e).slice(0, 200) });
  }
}
log("funder received", { eth: formatEther(total), funder: formatEther(await pub.getBalance({ address: to })) });
