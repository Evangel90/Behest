// Creates (or deletes) a complete set of deployment accounts as sub-accounts of
// one funded parent, so a clean deployment doesn't depend on the faucet.
// Usage:
//   pnpm --filter @behest/testnet bootstrap <suffix> --parent <funded.testnet>
//   pnpm --filter @behest/testnet bootstrap <suffix> --parent <funded.testnet> --teardown
// Then: BEHEST_DEPLOYMENT=<name> pnpm --filter @behest/testnet deploy-contract <suffix> --parent <funded.testnet>
// Teardown deletes every account (and scenario sub-accounts found in the
// keychain) with the parent as beneficiary, returning their NEAR. The contract
// account is kept: NEAR refuses to delete accounts with large state, so its
// storage NEAR stays with the (still working) contract.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, actions, nearToYocto } from "near-api-js";
import { account, log, provider, waitForKey } from "./near.js";

const suffix = process.argv[2];
const parentAt = process.argv.indexOf("--parent");
const parent = parentAt > 0 ? process.argv[parentAt + 1] : undefined;
if (!suffix || !parent) throw new Error("usage: bootstrap <suffix> --parent <funded account> [--teardown]");
const KEYS = join(homedir(), ".near-credentials/testnet");
const id = (n?: string) => `behest-${suffix}${n ? `-${n}` : ""}.${parent}`;

// Contract: wasm storage (~3 NEAR for ~300 KB) plus plan state.
const FUNDING: [string | undefined, string][] = [
  [undefined, "3.4"],
  ["admin", "0.3"],
  ["exec", "0.3"],
  ["owner", "5.5"],
  ["g1", "0.15"],
  ["g2", "0.15"],
  ["g3", "0.15"],
  ["amara", "0.1"],
  ["tobi", "0.1"],
];

if (process.argv.includes("--teardown")) {
  // Scenario owners are children of the deployment owner; delete them first.
  const owner = id("owner");
  const children = readdirSync(KEYS).filter((f) => f.endsWith(`.${owner}.json`)).map((f) => f.slice(0, -5));
  for (const acc of [...children, ...FUNDING.filter(([n]) => n).map(([n]) => id(n))]) {
    if (!existsSync(join(KEYS, `${acc}.json`))) continue;
    try {
      await account(acc).signAndSendTransaction({ receiverId: acc, actions: [actions.deleteAccount(parent)] });
      rmSync(join(KEYS, `${acc}.json`), { force: true });
      log("deleted", acc);
    } catch (e) {
      log("could not delete", { acc, error: String(e).slice(0, 160) });
    }
  }
  log("kept the contract account (large state can't be deleted)", id());
} else {
  mkdirSync(KEYS, { recursive: true });
  for (const [n, near] of FUNDING) {
    // Resumable: skip accounts a previous (interrupted) run already created.
    if (existsSync(join(KEYS, `${id(n)}.json`)) && (await provider.viewAccount({ accountId: id(n) }).then(() => true, () => false))) {
      log("exists", id(n));
      continue;
    }
    const kp = KeyPair.fromRandom("ed25519");
    const prefix = `behest-${suffix}${n ? `-${n}` : ""}`;
    await account(parent).createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto(near as `${number}`) });
    writeFileSync(join(KEYS, `${id(n)}.json`), JSON.stringify({ account_id: id(n), public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    await waitForKey(id(n), kp.getPublicKey().toString());
    log("created", { account: id(n), near });
  }
}
