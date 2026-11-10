// Shared testnet helpers. Keys come from near-cli's legacy keychain
// (~/.near-credentials/testnet/<account>.json); nothing secret is committed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/** BEHEST_DEPLOYMENT selects deployments/<name>.json (default "testnet", the main one). */
export const DEPLOYMENT_NAME = process.env.BEHEST_DEPLOYMENT || "testnet";
export const DEPLOYMENT_FILE = join(ROOT, `deployments/${DEPLOYMENT_NAME}.json`);

export const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
/** Reads can go to another RPC (NEAR_VIEW_RPC_URL) so a per-IP limit on the transaction RPC doesn't starve them. */
export const viewProvider = process.env.NEAR_VIEW_RPC_URL ? new JsonRpcProvider({ url: process.env.NEAR_VIEW_RPC_URL }) : provider;

/** Retries `fn` while the RPC answers 429 (rate limited), with exponential backoff. */
export async function retry429<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries || !/-429|Rate limits exceeded|\b429\b/.test(`${String(e)} ${String((e as { cause?: unknown })?.cause ?? "")}`)) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** i));
    }
  }
}

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
  retry429(() => viewProvider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } }) as Promise<T>);

export async function call(
  signer: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  opts: { tgas?: number; deposit?: bigint } = {},
) {
  // A rate-limited send never reached the chain, so it is safe to repeat.
  return retry429(() =>
    account(signer).callFunction({
      contractId,
      methodName,
      args,
      gas: teraToGas(opts.tgas ?? 30),
      deposit: opts.deposit ?? 0n,
    }),
  );
}

/** Rewrites KEY=value lines in the root .env, leaving every other line untouched. */
export function setEnv(values: Record<string, string>) {
  const file = join(ROOT, ".env");
  if (DEPLOYMENT_NAME !== "testnet" && Object.keys(values).some((k) => k.startsWith("BEHEST_") || k.startsWith("ADMIN_") || k.startsWith("EXECUTOR_"))) {
    log(`not writing .env for deployment "${DEPLOYMENT_NAME}" (only the main deployment owns those values)`);
    return;
  }
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

/**
 * Returns the NEAR held by earlier scenario owners (<prefix><ts>.<parent>) to
 * `parent`: withdraws idle escrow where no release is open, then deletes the
 * account. Their plans stay in the contract as history. Keeps repeated suite
 * runs from draining the deployment owner.
 */
export async function reclaimScenarioOwners(contract: string, parent: string) {
  const { readdirSync, rmSync } = await import("node:fs");
  const { actions } = await import("near-api-js");
  const dir = join(homedir(), ".near-credentials/testnet");
  // Only scenario owners: a short lowercase prefix plus a base-36 timestamp
  // (e.g. happymw7v6arh). Deployment accounts made by `bootstrap` under the
  // same parent (behest-<suffix>-…) never match.
  const scenario = new RegExp(`^[a-z]{2,12}m[0-9a-z]{7}\\.${parent.replace(/\./g, "\\.")}\\.json$`);
  // Names end in Date.now() in base 36: leave recent ones, which may belong to
  // a scenario still running in parallel (a Bitcoin run takes hours).
  const age = (id: string) => Date.now() - parseInt(id.split(".")[0]!.match(/m[0-9a-z]{7}$/)![0], 36);
  const owners = readdirSync(dir)
    .filter((f) => scenario.test(f))
    .map((f) => f.slice(0, -5))
    .filter((id) => age(id) > 6 * 3_600_000);
  let n = 0;
  for (const owner of owners) {
    try {
      const p = await view<{ plan: { escrow: string; proposal: unknown } } | null>(contract, "get_plan", { owner }).catch(() => null);
      if (p && !p.plan.proposal && BigInt(p.plan.escrow) > 0n) await call(owner, contract, "withdraw", { amount: p.plan.escrow });
      await account(owner).signAndSendTransaction({ receiverId: owner, actions: [actions.deleteAccount(parent)] });
      rmSync(join(dir, `${owner}.json`));
      n++;
    } catch (e) {
      log("could not reclaim", { owner, error: String(e).slice(0, 120) });
    }
  }
  if (n) log("reclaimed earlier scenario owners", { count: n });
}
