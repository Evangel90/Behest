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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";
import { ROOT, account, call, keyOf, log, provider, saveDeployment, setEnv, view, waitForKey } from "./near.js";
import { WETH_TOKEN } from "./sepolia.js";

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
  // Sepolia runs at ≈0 base fee and ≈1–1.5 gwei priority. The cap sizes the fee
  // reserve locked per transfer (250k × cap), so keep it low on testnet; a
  // spike above it only delays a transfer (FeeAboveCap, retried later).
  eth_max_fee_cap: "3000000000", // 3 gwei
  eth_initial_max_fee: "2000000000", // 2 gwei
  eth_priority_fee: "1000000000", // 1 gwei
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

const config = await view<{ executors: string[]; demo_timers: boolean; eth_light_client?: string | null; erc20_tokens?: { address: string }[]; nep141_tokens?: { account_id: string }[] }>(contract, "get_config");
if (!config.demo_timers) throw new Error("expected a demo-timers build on testnet");
if (!(config.erc20_tokens ?? []).some((t) => t.address === WETH_TOKEN.address)) {
  await call(admin, contract, "set_erc20_tokens", { tokens: [WETH_TOKEN] });
  log("ERC-20 allowlist set", { tokens: [WETH_TOKEN.symbol] });
}
// D22: the Ethereum (Sepolia) light client on NEAR that proves reverts.
const ETH_LIGHT_CLIENT = process.env.ETH_LIGHT_CLIENT?.trim() || "client-eth2.sepolia.testnet";
if (config.eth_light_client !== ETH_LIGHT_CLIENT) {
  await call(admin, contract, "set_eth_light_client", { account_id: ETH_LIGHT_CLIENT });
  log("Ethereum light client set", { account_id: ETH_LIGHT_CLIENT });
}
// wNEAR: wrap.testnet registers an account for 0.00125 NEAR (storage_balance_bounds.min).
const WNEAR = { account_id: "wrap.testnet", symbol: "wNEAR", decimals: 24, storage_deposit: "1250000000000000000000" };
// Listing registers the contract with the token, paid by the attached deposit.
if (!(config.nep141_tokens ?? []).some((t) => t.account_id === WNEAR.account_id)) {
  await call(admin, contract, "set_nep141_tokens", { tokens: [WNEAR] }, { deposit: BigInt(WNEAR.storage_deposit), tgas: 50 });
  log("NEP-141 allowlist set", { tokens: [WNEAR.symbol] });
} else if ((await view(WNEAR.account_id, "storage_balance_of", { account_id: contract })) === null) {
  // Listed by an older contract that didn't register itself.
  await call(admin, WNEAR.account_id, "storage_deposit", { account_id: contract, registration_only: true }, { deposit: BigInt(WNEAR.storage_deposit) });
  log("contract registered with token", { token: WNEAR.account_id });
}
if (!config.executors.includes(executor)) {
  await call(admin, contract, "add_executor", { account_id: executor });
  log("executor registered", { executor });
}
// D24: the gas relayer's transactions get plan storage from the sponsor pool.
// The admin keeps the pool topped up to SPONSOR_POOL_NEAR (default 1 NEAR).
const relayerId = process.env.RELAYER_ACCOUNT_ID?.trim();
const sponsor = (await view<{ sponsor?: { relayer: string | null; allowance_per_owner: string; daily_new_plans: number } }>(contract, "get_config")).sponsor;
if (!sponsor) throw new Error("this build has no sponsor pool (D24)");
if (relayerId && sponsor.relayer !== relayerId) {
  await call(admin, contract, "set_sponsor_config", { config: { ...sponsor, relayer: relayerId } });
  log("sponsor relayer set", { relayer: relayerId, allowance_per_owner: sponsor.allowance_per_owner, daily_new_plans: sponsor.daily_new_plans });
}
const poolTarget = nearToYocto((process.env.SPONSOR_POOL_NEAR?.trim() || "1") as `${number}`);
const pool = BigInt((await view<{ pool: string }>(contract, "get_sponsorship", { owner: admin })).pool);
if (pool < poolTarget) {
  await call(admin, contract, "fund_sponsor_pool", {}, { deposit: poolTarget - pool });
  log("sponsor pool funded", { added: (poolTarget - pool).toString(), pool: poolTarget.toString() });
}

// D25: tiers are paid in USDC. On testnet that is a mock token with a public
// faucet (contracts/mock-usdc), deployed once as behest-<suffix>-usdc.testnet
// (the admin pays its storage). USDC_TOKEN_ID points at another token instead.
const usdc = process.env.USDC_TOKEN_ID?.trim() || id("usdc");
if (!process.env.USDC_TOKEN_ID?.trim()) {
  const exists = await provider.viewAccount({ accountId: usdc }).then(() => true, () => false);
  const keyFile = join(homedir(), ".near-credentials/testnet", `${usdc}.json`);
  if (!exists) {
    const kp = KeyPair.fromRandom("ed25519");
    await account(admin).createAccount({ newAccountId: usdc, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("2.5") });
    writeFileSync(keyFile, JSON.stringify({ account_id: usdc, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    await waitForKey(usdc, kp.getPublicKey().toString());
    log("mock USDC account created", { usdc });
  }
  const usdcState = await account(usdc).getState();
  if (usdcState.codeHash === "11111111111111111111111111111111") {
    if (!existsSync(keyFile)) throw new Error(`no key for ${usdc}`);
    const usdcWasm = readFileSync(join(ROOT, "target/near-usdc/mock_usdc.wasm"));
    await account(usdc).signAndSendTransaction({ receiverId: usdc, actions: [actions.deployContract(usdcWasm), actions.functionCall("new", {}, teraToGas(30), 0n)] });
    log("mock USDC deployed", { usdc, bytes: usdcWasm.length });
  }
}
if ((await view(usdc, "storage_balance_of", { account_id: contract })) === null) {
  await call(admin, usdc, "storage_deposit", { account_id: contract, registration_only: true }, { deposit: nearToYocto("0.00125") });
  log("contract registered with USDC", { usdc });
}
const tierCfg = await view<{ fee_token: string | null }>(contract, "get_tier_config");
if (tierCfg.fee_token !== usdc) {
  await call(admin, contract, "set_tier_config", { config: { ...tierCfg, fee_token: usdc } });
  log("plan tiers on", { fee_token: usdc });
}

saveDeployment({
  contract,
  admin,
  executor,
  owner: id("owner"),
  guardians: [id("g1"), id("g2"), id("g3")],
  heirs: [id("amara"), id("tobi")],
  usdc,
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
