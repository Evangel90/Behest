// Live D23/D24: a whole plan run by EVM wallets through the gas relayer.
// Usage: pnpm --filter @behest/testnet e2e-evm   (needs the relayer at RELAYER_URL, default http://localhost:8787)
//
// Throwaway secp256k1 keys are the owner, both guardians and both heirs; their
// NEAR identities are eth-implicit accounts (0x…). The owner creates the plan
// with no deposit (storage from the sponsor pool), a funded NEAR account
// deposits escrow for it, guardians propose and approve, heirs claim, and
// the payouts create the heirs' 0x accounts. Nobody but the relayer pays gas.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Account, nearToYocto } from "near-api-js";
import { evmCall, type RelayResult } from "@behest/relayer/client";
import { networkOf, signedActionMessage } from "@behest/relayer/evm";
import { JsonRpcProvider } from "near-api-js";
import { call, loadDeployment, log, payTier } from "./near.js";
import { ensureScenarioFunds } from "./funding.js";

// Reads go to a separate RPC (fastnear rate-limits per IP and also carries the
// transactions), with backoff on rate limits.
const provider = new JsonRpcProvider({ url: process.env.NEAR_VIEW_RPC_URL || "https://test.rpc.fastnear.com" });
async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return (await provider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } })) as T;
    } catch (e) {
      if (i >= 6 || !/429|rate|timeout|fetch failed/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** i));
    }
  }
}

const d = loadDeployment();
const C = d.contract;
// Fresh scenario owners come out of the owner parent: top up first, never fail half way.
await ensureScenarioFunds(d, 0.2);
const RELAYER = process.env.RELAYER_URL || "http://localhost:8787";
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.2");
const EXPLORER = "https://testnet.nearblocks.io/txns";

type Status = "Active" | "Overdue" | "Proposed" | "Waiting" | "Eligible" | "Executing" | "Settled";
interface PlanView {
  status: Status;
  overdue_at_ms: number;
  now_ms: number;
  plan: { owner: string; escrow: string; proposal: null | { id: number; waiting_ends_at_ms: number | null; approvals: string[]; transfers: { heir: string; asset: string; destination: string; amount: string; state: string }[] } };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plan = (owner: string) => view<PlanView | null>(C, "get_plan", { owner }).then((p) => p!);
const idOf = (k: PrivateKeyAccount) => k.address.toLowerCase();

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

async function waitForChainTime(owner: string, targetMs: number) {
  for (;;) {
    const { now_ms } = await plan(owner);
    if (now_ms >= targetMs) return;
    log(`waiting ${Math.ceil((targetMs - now_ms) / 1000)}s of chain time`);
    await sleep(Math.min(targetMs - now_ms + 2_000, 20_000));
  }
}

const txs: Record<string, string> = {};

/** Signs `method(args)` as `key` with personal_sign and submits it through the relayer. */
async function signed(key: PrivateKeyAccount, summary: string, method: string, args: Record<string, unknown>): Promise<{ message: string; signature: string; out: RelayResult }> {
  const actor = idOf(key);
  const nonce = await view<string>(C, "get_evm_nonce", { account: actor });
  const message = signedActionMessage(summary, {
    contract: C,
    network: networkOf(C),
    actor,
    method,
    args,
    nonce: String(nonce),
    deadline_ms: String(Date.now() + 10 * MINUTE),
  });
  const signature = await key.signMessage({ message });
  const out = await evmCall(RELAYER, message, signature);
  if (out.status !== "ok") throw new Error(`${method} by ${actor} failed on chain: ${JSON.stringify(out.failure)}`);
  txs[`${method} ${actor.slice(0, 8)}`] = out.tx_hash;
  log(`${method} by ${actor} (nonce ${nonce})`, { tx: `${EXPLORER}/${out.tx_hash}`, result: out.result ?? null });
  return { message, signature, out };
}

async function nearBalance(id: string): Promise<{ total: bigint; codeHash: string } | null> {
  try {
    const s = await new Account(id, provider).getState();
    return { total: s.balance.total, codeHash: s.codeHash };
  } catch {
    return null;
  }
}

const wallet = () => privateKeyToAccount(generatePrivateKey());
const [owner, g1, g2, h1, h2] = [wallet(), wallet(), wallet(), wallet(), wallet()];
const O = idOf(owner);
log("EVM wallets", { owner: O, guardians: [idOf(g1), idOf(g2)], heirs: [idOf(h1), idOf(h2)] });
for (const h of [h1, h2]) assert((await nearBalance(idOf(h))) === null, "heir 0x accounts don't exist yet");

// 1. The owner creates a plan with no deposit: storage comes from the sponsor pool (D24).
const before = await view<{ pool: string; allowance_left: string; daily_left: number }>(C, "get_sponsorship", { owner: O });
log("sponsorship before", before);
// Two heirs need the Standard tier (D25). The owner holds no NEAR and no USDC:
// someone else (here the admin, as a relative would) pays it for the 0x account.
await payTier(C, O, 1, d.admin);
await signed(owner, "Create your Behest plan", "set_plan", {
  plan: {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: [idOf(g1), idOf(g2)],
    quorum: 2,
    heirs: [
      { account_id: idOf(h1), share_bps: 6000, near_destination: idOf(h1), eth_destination: null },
      { account_id: idOf(h2), share_bps: 4000, near_destination: idOf(h2), eth_destination: null },
    ],
  },
});
const after = await view<{ pool: string; allowance_left: string; daily_left: number }>(C, "get_sponsorship", { owner: O });
const cost = BigInt(before.pool) - BigInt(after.pool);
assert(cost > 0n && BigInt(before.allowance_left) - BigInt(after.allowance_left) === cost, "the pool paid the plan's storage, charged to the owner's allowance");
assert(after.daily_left === before.daily_left - 1, "one sponsored new plan counted today");
log("plan storage paid by the pool", { yocto: cost.toString(), allowance_left: after.allowance_left });
let p = await plan(O);
assert(p.plan.owner === O && p.status === "Active", "plan belongs to the 0x account");

// 2. Anyone can fund an owner's escrow; a funded NEAR account does it here.
await call(d.owner, C, "deposit", { owner: O }, { deposit: ESCROW });
log("escrow funded by a NEAR account", { from: d.owner, amount: ESCROW.toString() });

// 3. Check-in by signature, then a replay of it: the relayer refuses it, and so does the contract.
const checkIn = await signed(owner, "Check in", "check_in", {});
await expectError("EVM_NONCE", () => evmCall(RELAYER, checkIn.message, checkIn.signature));
await expectError("E_EVM_NONCE", () => call(d.owner, C, "evm_call", { message: checkIn.message, signature: checkIn.signature }, { tgas: 100 }));
// A guardian can't do an owner's job, and nobody can deposit through a signature.
await expectError("NO_ROLE", async () => {
  const nonce = await view<string>(C, "get_evm_nonce", { account: idOf(g1) });
  const message = signedActionMessage("Release now", { contract: C, network: networkOf(C), actor: idOf(g1), method: "claim", args: { owner: O }, nonce, deadline_ms: String(Date.now() + MINUTE) });
  return evmCall(RELAYER, message, await g1.signMessage({ message }));
});
await expectError("EVM_METHOD", async () => {
  const message = signedActionMessage("Deposit", { contract: C, network: networkOf(C), actor: O, method: "deposit", args: { owner: O }, nonce: "2", deadline_ms: String(Date.now() + MINUTE) });
  return evmCall(RELAYER, message, await owner.signMessage({ message }));
});

// 4. The owner goes silent; guardians propose and approve by signature.
p = await plan(O);
await waitForChainTime(O, p.overdue_at_ms);
assert((await plan(O)).status === "Overdue", "plan becomes Overdue");
const { out: proposed } = await signed(g1, `Propose releasing ${O}'s plan`, "propose_release", { owner: O });
p = await plan(O);
assert(p.status === "Proposed" && p.plan.proposal!.approvals.includes(idOf(g1)), "proposal counts as the first guardian's approval");
assert(Number(proposed.result) === p.plan.proposal!.id, "evm_call returns the proposal id");
await signed(g2, `Approve release #${p.plan.proposal!.id}`, "approve_release", { owner: O, proposal_id: p.plan.proposal!.id });
p = await plan(O);
assert(p.status === "Waiting", "quorum reached by EVM guardians");

// 5. After the waiting period, heirs claim by signature; payouts create their 0x accounts.
await waitForChainTime(O, p.plan.proposal!.waiting_ends_at_ms!);
for (const h of [h1, h2]) {
  const { out } = await signed(h, `Claim your share of ${O}'s plan`, "claim", { owner: O });
  assert(Number(out.result) >= 1, "claim started a transfer");
}
let done: PlanView | null = null;
for (let i = 0; i < 40; i++) {
  done = await plan(O);
  if (done.plan.proposal!.transfers.filter((t) => t.asset === "Near").every((t) => t.state === "Confirmed")) break;
  await sleep(3_000);
}
const near = done!.plan.proposal!.transfers.filter((t) => t.asset === "Near");
assert(near.length === 2 && near.every((t) => t.state === "Confirmed"), "both NEAR transfers confirmed");
for (const h of [h1, h2]) {
  const t = near.find((x) => x.heir === idOf(h))!;
  let acct = null;
  for (let i = 0; i < 10 && !acct; i++) {
    acct = await nearBalance(idOf(h));
    if (!acct) await sleep(3_000);
  }
  assert(acct, `${idOf(h)} exists after the payout`);
  assert(acct.total >= BigInt(t.amount), `${idOf(h)} holds its share`);
  log("heir account created by the payout", { account: idOf(h), balance: acct.total.toString(), share: t.amount, code_hash: acct.codeHash });
}
log("EVM e2e done", { owner: O, txs: Object.fromEntries(Object.entries(txs).map(([k, v]) => [k, `${EXPLORER}/${v}`])) });
process.exit(0);
