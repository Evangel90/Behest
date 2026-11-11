// Live D25 demo: plan tiers paid once, upfront, in (test) USDC.
//
//   1. A fresh owner saves a free plan: one heir, NEAR only.
//   2. A second heir with an Ethereum destination is refused (E_TIER_REQUIRED),
//      and so is a wNEAR deposit into escrow (refunded by the token).
//   3. A relative pays 20 USDC toward the plan: credit, still Free. A dust
//      first payment for an unknown account is refunded.
//   4. The owner pays the remaining 29: Standard. The two-heir plan saves and
//      wNEAR escrow is accepted.
//   5. Automatic release is refused until the owner pays the 100 USDC still
//      missing for Complete (149 in total); then it saves.
//   6. The treasury holds exactly 149 USDC from this run on top of what it
//      held before; the admin pays 1 USDC out of it. Plan escrow is untouched.
// Usage: pnpm --filter @behest/testnet e2e-tiers
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { account, call, loadDeployment, log, reclaimScenarioOwners, view, waitForKey } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const USDC = d.usdc;
if (!USDC) throw new Error("this deployment has no fee token; run deploy-contract first");
const WNEAR = "wrap.testnet";
const [G1, G2, G3] = d.guardians as [string, string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const $ = (n: number) => BigInt(Math.round(n * 1e6));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
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
interface TierView { tier: number; tier_name: string; paid: string; required: number; due: string[] }
interface Treasury { collected: string; withdrawn: string; pending: string; balance: string; payments: number }
const tier = (owner: string) => view<TierView>(C, "get_tier", { owner });
const treasury = () => view<Treasury>(C, "get_treasury");
const usdc = (id: string) => view<string>(USDC, "ft_balance_of", { account_id: id }).then(BigInt);
const mint = (who: string, amount: bigint) => call(who, USDC, "mint", { account_id: who, amount: amount.toString() });
const pay = (who: string, owner: string, amount: bigint) =>
  call(who, USDC, "ft_transfer_call", { receiver_id: C, amount: amount.toString(), msg: JSON.stringify({ pay_tier: owner }) }, { tgas: 80, deposit: 1n });

const policy = (heirs: { account_id: string; share_bps: number; near_destination: string; eth_destination: string | null }[]) => ({
  check_in_interval_ms: MINUTE,
  grace_ms: 0,
  waiting_period_ms: MINUTE,
  guardians: [G1, G2, G3],
  quorum: 2,
  heirs,
});
const ONE_HEIR = policy([{ account_id: AMARA, share_bps: 10_000, near_destination: AMARA, eth_destination: null }]);
const TWO_HEIRS = policy([
  { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: "0x00000000000000000000000000000000000000aa" },
  { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null },
]);
const AUTOMATIC = { mode: "Automatic", hybrid_grace_ms: 0, delay_signers: [], delay_quorum: 0, max_extension_ms: 0, max_total_extension_ms: 0, overrides: [] };

// ------------------------------------------------------------------ setup
const kp = KeyPair.fromRandom("ed25519");
const sub = `tier${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.3") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
log("owner", owner);
const before = await treasury();
log("treasury before", before);

// 1. Free plan.
await call(owner, C, "set_plan", { plan: ONE_HEIR }, { deposit: nearToYocto("0.05") });
let t = await tier(owner);
assert(t.tier === 0 && t.required === 0, "a one-heir NEAR plan is Free");
log("1. free plan saved", { tier: t.tier_name, due: t.due });

// 2. Standard features refused.
await expectError("E_TIER_REQUIRED", () => call(owner, C, "set_plan", { plan: TWO_HEIRS }, { deposit: nearToYocto("0.05") }));
await call(owner, WNEAR, "near_deposit", {}, { deposit: nearToYocto("0.01") });
await call(owner, WNEAR, "ft_transfer_call", { receiver_id: C, amount: nearToYocto("0.005").toString(), msg: "" }, { tgas: 80, deposit: 1n });
const ftEscrow = async () => BigInt((await view<{ ft_escrow: { token: string; amount: string }[] }>(C, "get_plan", { owner })).ft_escrow.find((b) => b.token === WNEAR)?.amount ?? "0");
assert((await ftEscrow()) === 0n, "a Free plan's wNEAR deposit is refunded");
log("2. two heirs and wNEAR escrow refused on Free");

// 3. A relative pays part; dust for a stranger is refunded.
const relative = d.admin;
await mint(relative, $(21));
const relBefore = await usdc(relative);
await pay(relative, owner, $(20));
t = await tier(owner);
assert(t.tier === 0 && BigInt(t.paid) === $(20) && BigInt(t.due[1]!) === $(29), "20 USDC is credit toward Standard");
const stranger = `nobody${Date.now().toString(36)}.testnet`;
await pay(relative, stranger, $(0.5));
assert((await usdc(relative)) === relBefore - $(20), "a dust first payment is refunded");
assert(BigInt((await tier(stranger)).paid) === 0n, "and nothing is recorded for the stranger");
log("3. relative paid 20 USDC; dust refunded", { due: t.due });

// 4. The owner pays the rest of Standard.
await mint(owner, $(129));
await pay(owner, owner, $(29));
t = await tier(owner);
assert(t.tier === 1 && t.tier_name === "Standard", "49 USDC buys Standard");
await call(owner, C, "set_plan", { plan: TWO_HEIRS }, { deposit: nearToYocto("0.05") });
await call(owner, WNEAR, "ft_transfer_call", { receiver_id: C, amount: nearToYocto("0.005").toString(), msg: "" }, { tgas: 80, deposit: 1n });
assert((await ftEscrow()) === nearToYocto("0.005"), "wNEAR escrow accepted on Standard");
log("4. Standard: two heirs with an Ethereum destination saved, wNEAR in escrow", { due: t.due });

// 5. Complete for the difference.
await expectError("E_TIER_REQUIRED", () => call(owner, C, "set_release_options", { options: AUTOMATIC }, { deposit: nearToYocto("0.01") }));
assert(BigInt(t.due[2]!) === $(100), "Complete costs the 100 still missing");
await pay(owner, owner, $(100));
t = await tier(owner);
assert(t.tier === 2 && BigInt(t.paid) === $(149), "149 USDC in total buys Complete");
await call(owner, C, "set_release_options", { options: AUTOMATIC }, { deposit: nearToYocto("0.01") });
log("5. Complete: automatic release saved", { paid: t.paid });

// 6. Treasury.
const after = await treasury();
assert(BigInt(after.collected) - BigInt(before.collected) === $(149), "the treasury collected exactly 149 USDC from this run");
assert(after.payments - before.payments === 3, "three payments");
const adminBefore = await usdc(d.admin);
await call(d.admin, C, "withdraw_treasury", { amount: $(1).toString(), to: d.admin }, { tgas: 80 });
const paidOut = await treasury();
assert(BigInt(paidOut.withdrawn) - BigInt(after.withdrawn) === $(1) && BigInt(paidOut.pending) === 0n, "1 USDC paid out");
assert((await usdc(d.admin)) === adminBefore + $(1), "and it arrived");
await expectError("E_UNAUTHORIZED", () => call(owner, C, "withdraw_treasury", { amount: "1", to: owner }, { tgas: 80 }));
log("6. treasury", paidOut);

// Clean up: the owner takes the wNEAR back.
await call(owner, C, "withdraw_ft", { token: WNEAR, amount: nearToYocto("0.005").toString() }, { tgas: 80 });
log("e2e-tiers passed", { owner, tier: t.tier_name });
