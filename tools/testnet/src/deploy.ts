// Deploys the demo-timers build and initialises it in one transaction, then
// registers the executor. Usage: pnpm --filter @behest/testnet deploy-contract <suffix> [--upgrade | --migrate]
// --upgrade replaces the code of an existing deployment without re-initialising;
// only use it when the stored state layout is unchanged.
// --migrate replaces the code and calls `migrate` in the same transaction
// (v0.1 → configurable ETH gas limit; plans convert lazily).
// Accounts behest-<suffix>[-admin|-exec|-owner|-g1..3|-amara|-tobi].testnet
// must already exist in the legacy keychain (created via the faucet), or pass
// --parent <account> after `bootstrap` created them as its sub-accounts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actions, teraToGas } from "near-api-js";
import { ROOT, account, call, keyOf, log, saveDeployment, setEnv, view } from "./near.js";

const suffix = process.argv[2];
const parentAt = process.argv.indexOf("--parent");
const parent = parentAt > 0 ? process.argv[parentAt + 1] : "testnet";
const migrate = process.argv.includes("--migrate");
const upgrade = migrate || process.argv.includes("--upgrade");
if (!suffix) throw new Error("usage: deploy <suffix>");
const id = (n?: string) => `behest-${suffix}${n ? `-${n}` : ""}.${parent}`;

const wasm = readFileSync(join(ROOT, "target/near-demo/behest.wasm"));
const sha = createHash("sha256").update(wasm).digest("hex");
const contract = id();
const admin = id("admin");
const executor = id("exec");

const init = {
  admin,
  mpc_contract: process.env.MPC_CONTRACT_ID || "v1.signer-prod.testnet",
  eth_chain_id: 11155111,
  // Sepolia base fee is ~0 and tips ~1 gwei (Nov 2026); the cap bounds the reserve.
  eth_max_fee_cap: "10000000000", // 10 gwei
  eth_initial_max_fee: "3000000000", // 3 gwei
  eth_priority_fee: "1500000000", // 1.5 gwei
  eth_gas_limit: 250_000, // a first transfer to an unused address needs ≈207k since Glamsterdam
};

const state = await account(contract).getState().catch(() => null);
const hasCode = state && state.codeHash !== "11111111111111111111111111111111";
if (hasCode && migrate) {
  log("upgrading code and migrating state", { contract, bytes: wasm.length, sha256: sha });
  await account(contract).signAndSendTransaction({
    receiverId: contract,
    actions: [actions.deployContract(wasm), actions.functionCall("migrate", { eth_gas_limit: init.eth_gas_limit }, teraToGas(100), 0n)],
  });
  await call(admin, contract, "set_eth_fees", { max_fee_cap: init.eth_max_fee_cap, initial_max_fee: init.eth_initial_max_fee, priority_fee: init.eth_priority_fee });
} else if (hasCode && upgrade) {
  log("upgrading code (state kept)", { contract, bytes: wasm.length, sha256: sha });
  await account(contract).deployContract(wasm);
} else if (hasCode) {
  log("contract already deployed; skipping deploy (pass --upgrade to replace code)", { contract });
} else {
  log("deploying", { contract, bytes: wasm.length, sha256: sha });
  await account(contract).signAndSendTransaction({
    receiverId: contract,
    actions: [actions.deployContract(wasm), actions.functionCall("new", init, teraToGas(100), 0n)],
  });
}

const config = await view<{ executors: string[]; demo_timers: boolean }>(contract, "get_config");
if (!config.demo_timers) throw new Error("expected a demo-timers build on testnet");
if (!config.executors.includes(executor)) {
  await call(admin, contract, "add_executor", { account_id: executor });
  log("executor registered", { executor });
}

saveDeployment({
  contract,
  admin,
  executor,
  owner: id("owner"),
  guardians: [id("g1"), id("g2"), id("g3")],
  heirs: [id("amara"), id("tobi")],
  wasmSha256: sha,
  deployedAt: new Date().toISOString(),
});
setEnv({
  BEHEST_CONTRACT_ID: contract,
  ADMIN_ACCOUNT_ID: admin,
  EXECUTOR_ACCOUNT_ID: executor,
  EXECUTOR_PRIVATE_KEY: keyOf(executor),
});
log("config", await view(contract, "get_config"));
