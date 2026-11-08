// Shared testnet helpers. Keys come from near-cli's legacy keychain
// (~/.near-credentials/testnet/<account>.json); nothing secret is committed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEPLOYMENT_FILE = join(ROOT, "deployments/testnet.json");

export const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });

export function keyOf(accountId: string): KeyPairString {
  const file = join(homedir(), ".near-credentials/testnet", `${accountId}.json`);
  return JSON.parse(readFileSync(file, "utf8")).private_key as KeyPairString;
}

export function account(accountId: string): Account {
  return new Account(accountId, provider, keyOf(accountId));
}

export interface Deployment {
  contract: string;
  admin: string;
  executor: string;
  owner: string;
  guardians: string[];
  heirs: string[];
  wasmSha256: string;
  deployedAt: string;
}

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_FILE)) throw new Error("no deployment: run pnpm --filter @behest/testnet deploy-contract");
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export function saveDeployment(d: Deployment) {
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + "\n");
}

// Optimistic finality: `call` returns once its receipts executed optimistically,
// and a "final" read can lag that by a block or two (seen as a flaky null proposal).
export const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } }) as Promise<T>;

export async function call(
  signer: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  opts: { tgas?: number; deposit?: bigint } = {},
) {
  return account(signer).callFunction({
    contractId,
    methodName,
    args,
    gas: teraToGas(opts.tgas ?? 30),
    deposit: opts.deposit ?? 0n,
  });
}

/** Rewrites KEY=value lines in the root .env, leaving every other line untouched. */
export function setEnv(values: Record<string, string>) {
  const file = join(ROOT, ".env");
  let text = readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
}

export const log = (msg: string, data?: unknown) => console.log(`• ${msg}`, data === undefined ? "" : JSON.stringify(data));

/** A freshly created account's key can take a block or two to be visible to the RPC node. */
export async function waitForKey(accountId: string, publicKey: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "optimistic" } });
      return;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
