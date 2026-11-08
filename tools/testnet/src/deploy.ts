// Deploys the demo-timers build and initialises it in one transaction, then
// registers the executor. Usage: pnpm --filter @behest/testnet deploy-contract <suffix>
// Accounts behest-<suffix>[-admin|-exec|-owner|-g1..3|-amara|-tobi].testnet
// must already exist in the legacy keychain (created via the faucet).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actions, teraToGas } from "near-api-js";
import { ROOT, account, call, keyOf, log, saveDeployment, setEnv, view } from "./near.js";

const suffix = process.argv[2];
if (!suffix) throw new Error("usage: deploy <suffix>");
const id = (n?: string) => `behest-${suffix}${n ? `-${n}` : ""}.testnet`;

const wasm = readFileSync(join(ROOT, "target/near-demo/behest.wasm"));
const sha = createHash("sha256").update(wasm).digest("hex");
const contract = id();
const admin = id("admin");
const executor = id("exec");

const init = {
  admin,
  mpc_contract: process.env.MPC_CONTRACT_ID || "v1.signer-prod.testnet",
  eth_chain_id: 11155111,
  eth_max_fee_cap: "50000000000", // 50 gwei
  eth_initial_max_fee: "20000000000", // 20 gwei
  eth_priority_fee: "2000000000", // 2 gwei
};

const state = await account(contract).getState().catch(() => null);
const hasCode = state && state.codeHash !== "11111111111111111111111111111111";
if (hasCode) {
  log("contract already deployed; skipping deploy", { contract });
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
