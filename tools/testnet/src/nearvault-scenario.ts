// Live NEAR vault demo: a plan's NEAR deposit address, derived for the
// contract by the MPC network (Ed25519), funded by a plain transfer and swept
// into the plan's escrow by the executor's sweeper.
//
//   1. A fresh owner saves a plan; anyone registers its NEAR vault. A second
//      registration is refused; sweeping before there's a vault is refused.
//   2. A stranger sends 0.3 NEAR to the vault address (a plain transfer, as
//      from an exchange). Nothing moves until a sweep.
//   3. The sweeper (services/executor) asks the contract to sign the sweep
//      and broadcasts it: the escrow grows by exactly the swept amount and
//      only dust stays in the vault.
//   4. A second pass with nothing new to sweep does nothing.
// Usage: pnpm --filter @behest/testnet e2e-nearvault
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto, type KeyPairString } from "near-api-js";
import { createNearVaultPort, sweepVaults, sweepable } from "../../../services/executor/src/nearvault.js";
import { ensureScenarioFunds } from "./funding.js";
import { account, call, keyOf, loadDeployment, log, provider, reclaimScenarioOwners, view, waitForKey } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
await ensureScenarioFunds(d, 0.6);
const C = d.contract;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MINUTE = 60_000;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => unknown, msg: string): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await read();
    if (ok(v)) return v;
    if (i >= 12) throw new Error(`assertion failed: ${msg}`);
    await sleep(2_000);
  }
}
async function expectError(code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const detail = JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (String((e as Error)?.message ?? e).includes(code) || detail.includes(code)) return log(`rejected as expected: ${code}`);
    throw new Error(`expected ${code}, got: ${String(e)} ${detail.slice(0, 400)}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
const escrow = async (owner: string) => BigInt((await view<{ plan: { escrow: string } }>(C, "get_plan", { owner })).plan.escrow);
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);

// ------------------------------------------------------------------ setup
const kp = KeyPair.fromRandom("ed25519");
const sub = `nvt${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.3") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
await call(owner, C, "set_plan", {
  plan: { check_in_interval_ms: 60 * MINUTE, grace_ms: 0, waiting_period_ms: MINUTE, guardians: d.guardians, quorum: 2, heirs: [{ account_id: d.heirs[0], share_bps: 10_000, near_destination: d.heirs[0], eth_destination: null }] },
}, { deposit: nearToYocto("0.05") });

// 1. Register.
const [G1] = d.guardians as [string];
await expectError("E_NO_NEAR_VAULT", () => call(G1, C, "sweep_near_vault", { owner, amount: "1", nonce: 1, block_hash: "11111111111111111111111111111111" }, { tgas: 120 }));
await call(G1, C, "register_near_vault", { owner }, { tgas: 60 });
const vault = await eventually(() => view<{ account_id: string; public_key: string } | null>(C, "get_near_vault", { owner }), (v) => !!v, "vault registered");
assert(vault && /^[0-9a-f]{64}$/.test(vault.account_id), "an implicit account id");
await expectError("E_NEAR_VAULT_EXISTS", () => call(G1, C, "register_near_vault", { owner }, { tgas: 60 }));
log("1. NEAR vault registered", vault);

// 2. Fund with a plain transfer.
const SENT = nearToYocto("0.3");
await account(d.owner).transfer({ receiverId: vault!.account_id, amount: SENT });
await eventually(() => balance(vault!.account_id).catch(() => 0n), (b) => b === SENT, "vault funded");
const before = await escrow(owner);
log("2. 0.3 NEAR sent to the vault by a plain transfer; escrow unchanged", { escrow: before.toString() });

// 3. Sweep (the executor's own code, signed by any account: here G1).
const port = createNearVaultPort({ rpcUrl: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com", contractId: C, executorAccountId: G1, executorPrivateKey: keyOf(G1) as KeyPairString });
const only = { ...port, listVaults: async () => [[owner, vault!.account_id]] as [string, string][] };
const acct = await port.account(vault!.account_id);
const expected = sweepable(acct!.amount, acct!.storageUsage);
const r1 = await sweepVaults(only, log);
assert(r1.get(owner) === "swept", `swept (got ${r1.get(owner)})`);
const after = await eventually(() => escrow(owner), (e) => e === before + expected, "escrow grew by the swept amount");
const left = await balance(vault!.account_id);
assert(left < nearToYocto("0.03"), `only the fee reserve and gas refund left (${left})`);
log("3. swept into the plan", { swept: expected.toString(), escrow: after.toString(), leftInVault: left.toString(), sweep: await port.getSweep(owner) });

// 4. Nothing more to do.
const r2 = await sweepVaults(only, log);
assert(r2.get(owner) === "empty", "second pass: empty");
log("4. second pass: nothing to sweep");
log("e2e-nearvault passed", { owner, vault: vault!.account_id });
