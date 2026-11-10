// Refills a testnet account from NEAR's account-creation faucet, no website
// needed: each round creates a throwaway account (the helper funds new
// accounts, ~10 NEAR) and deletes it with the target as beneficiary, which
// moves its whole balance over. Optionally tops up the D24 sponsor pool.
//
//   pnpm topup <account> [rounds=1] [--pool <NEAR>]
//   pnpm topup behest-ekkr6-admin.testnet 2 --pool 5
//
// Testnet only. The helper rate-limits; on a refusal this stops and says so.
import { Account, KeyPair, actions, nearToYocto, type KeyPairString } from "near-api-js";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { call, loadDeployment, log, provider, retry429, view, waitForKey } from "./near.js";

// Throwaway keys go to the legacy keychain BEFORE the faucet funds the account,
// so a crash (or a rate-limited sweep) never strands its NEAR: the next run
// sweeps any behest-topup-* account it finds there.
const KEYCHAIN = join(homedir(), ".near-credentials/testnet");

const HELPER = process.env.NEAR_HELPER_URL || "https://helper.nearprotocol.com/account";

const args = process.argv.slice(2);
const poolAt = args.indexOf("--pool");
const poolNear = poolAt >= 0 ? args.splice(poolAt, 2)[1] : undefined;
const [target, roundsArg] = args;
if (!target?.endsWith(".testnet")) {
  console.error("usage: pnpm topup <account.testnet> [rounds=1] [--pool <NEAR>]");
  process.exit(1);
}
const rounds = Math.max(1, Math.min(10, Number(roundsArg ?? 1) || 1));

async function balance(accountId: string): Promise<bigint> {
  const a = await retry429(() => provider.viewAccount({ accountId, blockQuery: { finality: "optimistic" } }));
  return BigInt(a.amount);
}

/** Deletes a throwaway account into the target; true if it existed and was swept. */
async function sweep(temp: string, key: KeyPairString): Promise<bigint | null> {
  let got: bigint;
  try {
    got = await balance(temp);
  } catch {
    return null; // never created (faucet refused) or already swept
  }
  await retry429(() => new Account(temp, provider, key).signAndSendTransaction({ receiverId: temp, actions: [actions.deleteAccount(target!)] }));
  return got;
}

function forget(temp: string) {
  rmSync(join(KEYCHAIN, `${temp}.json`), { force: true });
}
const near = (y: bigint) => `${(Number(y / 10n ** 21n) / 1000).toFixed(3)} NEAR`;

const before = await balance(target);
log("target", { account: target, balance: near(before) });

// Leftovers from an earlier run that stopped half way.
mkdirSync(KEYCHAIN, { recursive: true });
for (const f of readdirSync(KEYCHAIN).filter((f) => f.startsWith("behest-topup-") && f.endsWith(".json"))) {
  const temp = f.slice(0, -5);
  const got = await sweep(temp, JSON.parse(readFileSync(join(KEYCHAIN, f), "utf8")).private_key as KeyPairString);
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
  const got = await sweep(temp, keyPair.toString() as KeyPairString);
  forget(temp);
  log(`round ${i}: ${temp} funded with ${near(got ?? 0n)} and swept into ${target}`);
  if (i < rounds) await new Promise((r) => setTimeout(r, 5_000));
}

const after = await balance(target);
log("target", { account: target, balance: near(after), gained: near(after - before) });

if (poolNear) {
  // The sponsor pool lives in the contract; the target pays it in (it must be a key we hold).
  const { contract } = loadDeployment();
  const deposit = nearToYocto(poolNear as `${number}`);
  await call(target, contract, "fund_sponsor_pool", {}, { deposit });
  const s = await view<{ pool: string }>(contract, "get_sponsorship", { owner: target });
  log("sponsor pool topped up", { added: `${poolNear} NEAR`, pool: near(BigInt(s.pool)) });
}
