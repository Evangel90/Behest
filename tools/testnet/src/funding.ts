// Testnet NEAR for scenario accounts. `faucetTopup` refills an account from
// NEAR's account-creation faucet, no website needed: each round creates a
// throwaway account (the helper funds new accounts, ~10 NEAR) and deletes it
// with the target as beneficiary, which moves its whole balance over.
// `ensureFunds` runs before a scenario: any account below what the scenario
// needs is topped up first, so a run never fails half way for lack of NEAR.
import { Account, KeyPair, actions, type KeyPairString } from "near-api-js";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, provider, retry429, waitForKey } from "./near.js";

// Throwaway keys go to the legacy keychain BEFORE the faucet funds the account,
// so a crash (or a rate-limited sweep) never strands its NEAR: the next run
// sweeps any behest-topup-* account it finds there.
const KEYCHAIN = join(homedir(), ".near-credentials/testnet");
const HELPER = process.env.NEAR_HELPER_URL || "https://helper.nearprotocol.com/account";
const YOCTO = 10n ** 24n;

export const near = (y: bigint) => `${(Number(y / 10n ** 21n) / 1000).toFixed(3)} NEAR`;
export const nearOf = (n: number) => (BigInt(Math.round(n * 1000)) * YOCTO) / 1000n;

export async function balance(accountId: string): Promise<bigint> {
  const a = await retry429(() => provider.viewAccount({ accountId, blockQuery: { finality: "optimistic" } }));
  return BigInt(a.amount);
}

/** Deletes a throwaway account into `target`; its balance if it existed and was swept. */
async function sweep(temp: string, key: KeyPairString, target: string): Promise<bigint | null> {
  let got: bigint;
  try {
    got = await balance(temp);
  } catch {
    return null; // never created (faucet refused) or already swept
  }
  await retry429(() => new Account(temp, provider, key).signAndSendTransaction({ receiverId: temp, actions: [actions.deleteAccount(target)] }));
  return got;
}

const forget = (temp: string) => rmSync(join(KEYCHAIN, `${temp}.json`), { force: true });

/** Up to `rounds` faucet rounds into `target` (≈10 NEAR each). Returns what arrived; stops at the first refusal. */
export async function faucetTopup(target: string, rounds: number): Promise<bigint> {
  if (!target.endsWith(".testnet")) throw new Error(`faucet top-ups are testnet only (${target})`);
  const before = await balance(target);
  mkdirSync(KEYCHAIN, { recursive: true });
  // Leftovers from an earlier run that stopped half way.
  for (const f of readdirSync(KEYCHAIN).filter((f) => f.startsWith("behest-topup-") && f.endsWith(".json"))) {
    const temp = f.slice(0, -5);
    const got = await sweep(temp, JSON.parse(readFileSync(join(KEYCHAIN, f), "utf8")).private_key as KeyPairString, target);
    if (got != null) log(`leftover ${temp} swept into ${target}`, near(got));
    forget(temp);
  }
  for (let i = 1; i <= rounds; i++) {
    const keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();
    const temp = `behest-topup-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.testnet`;
    writeFileSync(join(KEYCHAIN, `${temp}.json`), JSON.stringify({ account_id: temp, public_key: publicKey, private_key: keyPair.toString() }), { mode: 0o600 });
    const res = await fetch(HELPER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: temp, newAccountPublicKey: publicKey }),
    });
    if (!res.ok) {
      forget(temp);
      log(`round ${i}: the faucet refused (HTTP ${res.status}); it rate-limits, so try again later`, (await res.text()).slice(0, 200));
      break;
    }
    await retry429(() => waitForKey(temp, publicKey, 60_000));
    const got = await sweep(temp, keyPair.toString() as KeyPairString, target);
    forget(temp);
    log(`round ${i}: ${temp} funded with ${near(got ?? 0n)} and swept into ${target}`);
    if (i < rounds) await new Promise((r) => setTimeout(r, 5_000));
  }
  return (await balance(target)) - before;
}

/** Faucet rounds needed to lift `have` to `need` plus a margin (≈9.9 NEAR land per round). */
export function roundsFor(have: bigint, need: bigint, margin = nearOf(2)): number {
  if (have >= need) return 0;
  const missing = need + margin - have;
  return Number((missing + nearOf(9.9) - 1n) / nearOf(9.9));
}

/**
 * Before a scenario: every account below the NEAR it needs (in NEAR) is
 * topped up from the faucet. Throws before the scenario starts, never half
 * way, if the faucet can't cover the shortfall.
 */
export async function ensureFunds(needs: Record<string, number>) {
  const short: string[] = [];
  for (const [account, n] of Object.entries(needs)) {
    const need = nearOf(n);
    const have = await balance(account);
    const rounds = roundsFor(have, need);
    if (rounds === 0) continue;
    log("topping up before the scenario", { account, have: near(have), need: near(need), rounds });
    await faucetTopup(account, rounds);
    const now = await balance(account);
    if (now < need) short.push(`${account}: ${near(now)} < ${near(need)}`);
  }
  if (short.length) throw new Error(`not enough testnet NEAR and the faucet couldn't cover it: ${short.join("; ")}`);
}

/**
 * The deployment's standing accounts before a scenario: the owner parent pays
 * for the fresh scenario owners it creates (`ownerNear`, scenario-specific),
 * heirs and guardians pay their own gas where the relayer doesn't, and the
 * admin pays the gas of tier payments and setup calls.
 */
export async function ensureScenarioFunds(d: { owner: string; admin: string; heirs: string[]; guardians: string[] }, ownerNear: number) {
  const needs: Record<string, number> = { [d.owner]: ownerNear + 0.5, [d.admin]: 1 };
  for (const a of [...d.heirs, ...d.guardians]) needs[a] = 0.3;
  await ensureFunds(needs);
}
