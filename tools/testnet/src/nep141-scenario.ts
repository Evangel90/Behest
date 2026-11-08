// Live Stage 2 demo: a NEP-141 token (wNEAR on wrap.testnet) passed to heirs.
//
//   1. The owner wraps NEAR and deposits wNEAR with ft_transfer_call (msg = the
//      plan). A deposit naming a plan that doesn't exist is refunded by the token.
//   2. The owner withdraws part of it (allowed while no release is open).
//   3. Release: wNEAR is split 60/40 like NEAR. Each heir's destination is a
//      fresh account the token has never seen, so the contract registers it
//      (NEP-145 storage_deposit) first, paid from NEAR reserved out of the
//      plan's escrow at proposal time.
//   4. Heirs hold exactly their shares; the plan settles with the reserve spent.
// Usage: pnpm --filter @behest/testnet e2e-nep141
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { account, call, loadDeployment, log, reclaimScenarioOwners, view, waitForKey } from "./near.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
const C = d.contract;
const WNEAR = "wrap.testnet";
const [G1, G2] = d.guardians as [string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.05");
const WRAP = nearToYocto("0.02");
const DEPOSIT = nearToYocto("0.01");
const TAKE_BACK = nearToYocto("0.001");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
type Asset = "Near" | "Eth" | { Nep141: string } | { Erc20: string };
interface Transfer { heir: string; asset: Asset; destination: string; amount: string; state: string; failure: string | null; attempts: number }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; ft_escrow: { token: string; amount: string }[]; plan: { escrow: string; proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const ftOf = (p: PlanView) => BigInt(p.ft_escrow.find((b) => b.token === WNEAR)?.amount ?? "0");
const wnear = (id: string) => view<string>(WNEAR, "ft_balance_of", { account_id: id }).then(BigInt);
const registered = (id: string) => view<unknown>(WNEAR, "storage_balance_of", { account_id: id }).then((r) => r !== null);
const share = (total: bigint, bps: bigint) => (total * bps) / 10_000n;
const isFt = (t: Transfer) => typeof t.asset === "object" && "Nep141" in t.asset;
async function waitChain(owner: string, target: number) {
  for (let p = await plan(owner); p.now_ms < target; p = await plan(owner)) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}

// ------------------------------------------------------------------ setup
const kp = KeyPair.fromRandom("ed25519");
const sub = `nep${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.5") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${owner}.json`), JSON.stringify({ account_id: owner, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });

// Fresh implicit accounts: never registered with wrap.testnet.
const dest = { amara: Buffer.from(KeyPair.fromRandom("ed25519").getPublicKey().data).toString("hex"), tobi: Buffer.from(KeyPair.fromRandom("ed25519").getPublicKey().data).toString("hex") };
assert(!(await registered(dest.amara)) && !(await registered(dest.tobi)), "destinations start unregistered");

await call(owner, C, "set_plan", {
  plan: {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: d.guardians,
    quorum: 2,
    heirs: [
      { account_id: AMARA, share_bps: 6000, near_destination: dest.amara, eth_destination: null },
      { account_id: TOBI, share_bps: 4000, near_destination: dest.tobi, eth_destination: null },
    ],
  },
}, { deposit: nearToYocto("0.05") });
await call(owner, C, "deposit", { owner }, { deposit: ESCROW });

// ---------------------------------------------- 1. wrap and deposit wNEAR
await call(owner, WNEAR, "near_deposit", {}, { deposit: WRAP });
const wrapped = await wnear(owner);
await call(owner, WNEAR, "ft_transfer_call", { receiver_id: C, amount: DEPOSIT.toString(), msg: owner }, { deposit: 1n, tgas: 100 });
assert(ftOf(await plan(owner)) === DEPOSIT, "deposit credited to the plan");
assert((await wnear(owner)) === wrapped - DEPOSIT, "owner paid exactly the deposit");
await call(owner, WNEAR, "ft_transfer_call", { receiver_id: C, amount: "1000", msg: `nobody${Date.now()}.testnet` }, { deposit: 1n, tgas: 100 });
assert((await wnear(owner)) === wrapped - DEPOSIT, "deposit for an unknown plan refunded");
log("wNEAR deposited; stray deposit refunded", { owner, escrow: DEPOSIT.toString() });

// ------------------------------------------------- 2. owner takes some back
await call(owner, C, "withdraw_ft", { token: WNEAR, amount: TAKE_BACK.toString() }, { tgas: 100 });
const held = DEPOSIT - TAKE_BACK;
assert(ftOf(await plan(owner)) === held, "escrow reduced");
assert((await wnear(owner)) === wrapped - held, "owner received the withdrawal");
log("owner withdrew wNEAR", { amount: TAKE_BACK.toString(), left: held.toString() });

// ----------------------------------------------------------- 3. release
await waitChain(owner, (await plan(owner)).overdue_at_ms);
await call(G1, C, "propose_release", { owner });
const p0 = await plan(owner);
await call(G2, C, "approve_release", { owner, proposal_id: p0.plan.proposal!.id });
const cfg = await view<{ nep141_tokens: { account_id: string; storage_deposit: string }[] }>(C, "get_config");
const reg = BigInt(cfg.nep141_tokens.find((t) => t.account_id === WNEAR)!.storage_deposit);
const ts = p0.plan.proposal!.transfers;
const near = ts.filter((t) => t.asset === "Near").map((t) => BigInt(t.amount));
const fts = ts.filter(isFt).map((t) => [t.destination, BigInt(t.amount)] as const);
const nearTotal = ESCROW - 2n * reg;
assert(near[0] === share(nearTotal, 6000n) && near[1] === share(nearTotal, 4000n), "NEAR split after reserving two registrations");
assert(fts[0]![0] === dest.amara && fts[0]![1] === share(held, 6000n) && fts[1]![1] === share(held, 4000n), "wNEAR split 60/40");
log("release proposed", { near: near.map(String), wnear: fts.map(([, a]) => a.toString()), registrationReserve: (2n * reg).toString() });
await waitChain(owner, (await plan(owner)).plan.proposal!.waiting_ends_at_ms!);

await call(AMARA, C, "claim", { owner }, { tgas: 300 });
await call(TOBI, C, "claim", { owner }, { tgas: 300 });
let p = await plan(owner);
for (let i = 0; i < 10 && p.status !== "Settled"; i++) await sleep(3_000), (p = await plan(owner));
assert(p.status === "Settled", `plan settled (is ${p.status}: ${JSON.stringify(p.plan.proposal!.transfers.map((t) => [t.state, t.failure]))})`);

// ------------------------------------------------------------- 4. verify
assert((await wnear(dest.amara)) === fts[0]![1] && (await wnear(dest.tobi)) === fts[1]![1], "heirs hold exactly their wNEAR shares");
assert((await registered(dest.amara)) && (await registered(dest.tobi)), "destinations registered by the contract");
assert(ftOf(p) === 0n, "no wNEAR left in escrow");
assert(BigInt(p.plan.escrow) === nearTotal - near[0]! - near[1]!, "registration reserve fully spent, nothing else kept");
log("heirs received wNEAR", { amara: `${fts[0]![1]} → ${dest.amara.slice(0, 10)}…`, tobi: `${fts[1]![1]} → ${dest.tobi.slice(0, 10)}…` });

// cleanup: unwrap the owner's leftover so the next run reclaims it as NEAR
await call(owner, WNEAR, "near_withdraw", { amount: (await wnear(owner)).toString() }, { deposit: 1n });
console.log("✓ wNEAR deposited, partly withdrawn, and split to two fresh accounts the contract registered");
