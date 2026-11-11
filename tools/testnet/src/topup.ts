// Refills a testnet account from NEAR's account-creation faucet (see
// funding.ts). Optionally tops up the D24 sponsor pool.
//
//   pnpm topup <account> [rounds=1] [--pool <NEAR>]
//   pnpm topup behest-ekkr6-admin.testnet 2 --pool 5
//
// Testnet only. The helper rate-limits; on a refusal this stops and says so.
import { nearToYocto } from "near-api-js";
import { balance, faucetTopup, near } from "./funding.js";
import { call, loadDeployment, log, view } from "./near.js";

const args = process.argv.slice(2);
const poolAt = args.indexOf("--pool");
const poolNear = poolAt >= 0 ? args.splice(poolAt, 2)[1] : undefined;
const [target, roundsArg] = args;
if (!target?.endsWith(".testnet")) {
  console.error("usage: pnpm topup <account.testnet> [rounds=1] [--pool <NEAR>]");
  process.exit(1);
}
const rounds = Math.max(1, Math.min(10, Number(roundsArg ?? 1) || 1));

const before = await balance(target);
log("target", { account: target, balance: near(before) });
const gained = await faucetTopup(target, rounds);
log("target", { account: target, balance: near(before + gained), gained: near(gained) });

if (poolNear) {
  // The sponsor pool lives in the contract; the target pays it in (it must be a key we hold).
  const { contract } = loadDeployment();
  const deposit = nearToYocto(poolNear as `${number}`);
  await call(target, contract, "fund_sponsor_pool", {}, { deposit });
  const s = await view<{ pool: string }>(contract, "get_sponsorship", { owner: target });
  log("sponsor pool topped up", { added: `${poolNear} NEAR`, pool: near(BigInt(s.pool)) });
}
