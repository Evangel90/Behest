// Live testnet scenarios against the deployed contract (demo timers).
// Usage: pnpm --filter @behest/testnet e2e [scenario ...]   (default: all NEAR-only)
// Each scenario uses a fresh owner sub-account, since a settled plan is final.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { sponsoredCall } from "@behest/relayer/client";
import { account, call, loadDeployment, log, provider, view, waitForKey } from "./near.js";

const d = loadDeployment();
const C = d.contract;
const [G1, G2, G3] = d.guardians as [string, string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const ESCROW = nearToYocto("0.3");

type Status = "Active" | "Overdue" | "Proposed" | "Waiting" | "Eligible" | "Executing" | "Settled";
interface Transfer { heir: string; asset: "Near" | "Eth"; destination: string; amount: string; state: string; failure: string | null }
interface PlanView { status: Status; overdue_at_ms: number; now_ms: number; plan: { escrow: string; proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }

// ------------------------------------------------------------------ helpers

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function expectError(code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (String((e as Error)?.message ?? e).includes(code) || JSON.stringify(e).includes(code)) return log(`rejected as expected: ${code}`);
    throw new Error(`expected ${code}, got: ${String(e)}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

const plan = (owner: string) => view<PlanView | null>(C, "get_plan", { owner }).then((p) => p!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the chain clock passes `targetMs` (block time, not local time). */
async function waitForChainTime(owner: string, targetMs: number) {
  for (;;) {
    const { now_ms } = await plan(owner);
    if (now_ms >= targetMs) return;
    const left = targetMs - now_ms;
    log(`waiting ${Math.ceil(left / 1000)}s of chain time`);
    await sleep(Math.min(left + 2_000, 20_000));
  }
}

async function waitForStatus(owner: string, want: Status, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const p = await plan(owner);
    if (p.status === want) return p;
    if (Date.now() > end) throw new Error(`timed out waiting for ${want}; status ${p.status}`);
    await sleep(3_000);
  }
}

async function balance(id: string): Promise<bigint> {
  return BigInt((await account(id).getState()).balance.total);
}

/** Creates <prefix><ts>.<owner> with 0.6 NEAR and stores its key in the legacy keychain. */
async function freshOwner(prefix: string): Promise<string> {
  const kp = KeyPair.fromRandom("ed25519");
  const sub = `${prefix}${Date.now().toString(36)}`;
  const id = `${sub}.${d.owner}`;
  await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.6") });
  await waitForKey(id, kp.getPublicKey().toString());
  const dir = join(homedir(), ".near-credentials/testnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  log("owner", id);
  return id;
}

function demoPlan(opts: { quorum?: number; amaraEth?: string } = {}) {
  return {
    check_in_interval_ms: MINUTE,
    grace_ms: 0,
    waiting_period_ms: MINUTE,
    guardians: [G1, G2, G3],
    quorum: opts.quorum ?? 2,
    heirs: [
      { account_id: AMARA, share_bps: 6000, near_destination: AMARA, eth_destination: opts.amaraEth ?? null },
      { account_id: TOBI, share_bps: 4000, near_destination: TOBI, eth_destination: null },
    ],
  };
}

/** Owner creates the plan, funds 0.3 NEAR of escrow, then goes silent until overdue. */
async function overduePlan(prefix: string, opts?: Parameters<typeof demoPlan>[0]) {
  const owner = await freshOwner(prefix);
  await call(owner, C, "set_plan", { plan: demoPlan(opts) }, { deposit: nearToYocto("0.05") });
  await call(owner, C, "deposit", { owner }, { deposit: ESCROW });
  const p = await plan(owner);
  assert(p.status === "Active", "new plan is Active");
  await waitForChainTime(owner, p.overdue_at_ms);
  assert((await plan(owner)).status === "Overdue", "plan becomes Overdue");
  log("owner unreachable (Overdue)");
  return owner;
}

async function proposeAndApprove(owner: string, ethBalance: string | null = null) {
  const id = await call(G1, C, "propose_release", { owner, eth_balance: ethBalance });
  const proposal = (await plan(owner)).plan.proposal!;
  await call(G2, C, "approve_release", { owner, proposal_id: proposal.id });
  const p = await plan(owner);
  assert(p.status === "Waiting", "quorum reached starts the waiting period");
  log("quorum reached; waiting period started", { proposal: id, waiting_ends_at_ms: p.plan.proposal!.waiting_ends_at_ms });
  return p;
}

// ---------------------------------------------------------------- scenarios

const scenarios: Record<string, () => Promise<void>> = {
  /** Plan → unreachable → guardians → waiting → both heirs claim NEAR → settled. */
  async "happy-near"() {
    const owner = await overduePlan("happy");
    const p = await proposeAndApprove(owner);
    await expectError("E_NOT_ELIGIBLE", () => call(AMARA, C, "claim", { owner }, { tgas: 100 }));
    await waitForChainTime(owner, p.plan.proposal!.waiting_ends_at_ms!);

    const [a0, t0] = await Promise.all([balance(AMARA), balance(TOBI)]);
    await call(AMARA, C, "claim", { owner }, { tgas: 100 });
    await call(TOBI, C, "claim", { owner }, { tgas: 100 });
    const done = await waitForStatus(owner, "Settled");
    const amt = (h: string) => BigInt(done.plan.proposal!.transfers.find((t) => t.heir === h && t.asset === "Near")!.amount);
    // Heirs pay their own claim gas: 100 Tgas is prepaid (~0.01 NEAR) and the
    // unused part is refunded a block later, so allow 0.02 NEAR of difference.
    // Balance reads can lag the plan view by a block, so poll briefly.
    const slack = nearToYocto("0.02");
    let a1 = 0n, t1 = 0n;
    for (let i = 0; i < 10; i++) {
      [a1, t1] = await Promise.all([balance(AMARA), balance(TOBI)]);
      if (a1 - a0 > amt(AMARA) - slack && t1 - t0 > amt(TOBI) - slack) break;
      await sleep(3_000);
    }
    log("received", { amara: (a1 - a0).toString(), tobi: (t1 - t0).toString() });
    assert(a1 - a0 > amt(AMARA) - slack, "amara received 60%");
    assert(t1 - t0 > amt(TOBI) - slack, "tobi received 40%");
    assert(!(await view<string[]>(C, "list_open_releases", {})).includes(owner), "settled release leaves the open index");
    log("settled", { amara: amt(AMARA).toString(), tobi: amt(TOBI).toString() });
  },

  /** Owner reappears during the waiting period: one check-in cancels the release. */
  async "owner-cancel"() {
    const owner = await overduePlan("cancel");
    await proposeAndApprove(owner);
    await call(owner, C, "check_in", {});
    const p = await plan(owner);
    assert(p.status === "Active" && p.plan.proposal === null, "check-in cancels the proposal");
    assert(p.plan.escrow === ESCROW.toString(), "reserved NEAR returns to escrow");
    await expectError("E_NOT_ELIGIBLE", () => call(AMARA, C, "claim", { owner }, { tgas: 100 }));
    log("release cancelled by owner; escrow restored");
  },

  /** Quorum 3 of 3 with one guardian missing: the release cannot proceed and the threshold is never lowered. */
  async "missing-guardian"() {
    const owner = await overduePlan("missing", { quorum: 3 });
    await call(G1, C, "propose_release", { owner, eth_balance: null });
    const id = (await plan(owner)).plan.proposal!.id;
    await call(G2, C, "approve_release", { owner, proposal_id: id });
    await sleep(MINUTE + 5_000);
    const p = await plan(owner);
    assert(p.status === "Proposed", "still Proposed without the third guardian");
    await expectError("E_NOT_ELIGIBLE", () => call(AMARA, C, "claim", { owner }, { tgas: 100 }));
    await expectError("E_ALREADY_VOTED", () => call(G2, C, "approve_release", { owner, proposal_id: id }));
    log("release paused at 2/3 approvals; owner can still cancel");
    await call(owner, C, "cancel_release", {});
  },

  /** ETH vault balance below the fee reserve: the proposal is refused. */
  async "insufficient-fee-reserve"() {
    const owner = await overduePlan("fees", { amaraEth: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" });
    // reserve = 1 ETH heir × gas limit × fee cap (250k × 10 gwei = 0.0025 ETH on testnet)
    await expectError("E_INSUFFICIENT_FEE_RESERVE", () => call(G1, C, "propose_release", { owner, eth_balance: "1000000000000000" }));
    log("proposal refused: vault balance does not cover the network-fee reserve");
    await call(owner, C, "check_in", {});
  },

  /** Guardians and heirs act through the gas relayer and spend no NEAR at all. */
  async "sponsored"() {
    const relayer = process.env.RELAYER_URL || "http://localhost:8787";
    const owner = await overduePlan("sponsored");
    const [g1Before, g2Before, a0, t0] = await Promise.all([balance(G1), balance(G2), balance(AMARA), balance(TOBI)]);

    await sponsoredCall(account(G1), relayer, C, "propose_release", { owner, eth_balance: null });
    const id = (await plan(owner)).plan.proposal!.id;
    await sponsoredCall(account(G2), relayer, C, "approve_release", { owner, proposal_id: id });
    const p = await plan(owner);
    assert(p.status === "Waiting", "sponsored votes reach quorum");
    await waitForChainTime(owner, p.plan.proposal!.waiting_ends_at_ms!);

    await sponsoredCall(account(AMARA), relayer, C, "claim", { owner }, 100);
    await sponsoredCall(account(TOBI), relayer, C, "claim", { owner }, 100);
    const done = await waitForStatus(owner, "Settled");
    const amt = (h: string) => BigInt(done.plan.proposal!.transfers.find((t) => t.heir === h)!.amount);

    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      const [a1, t1] = await Promise.all([balance(AMARA), balance(TOBI)]);
      ok = a1 - a0 === amt(AMARA) && t1 - t0 === amt(TOBI);
      if (!ok) await sleep(3_000);
    }
    assert(ok, "heirs received exactly their shares: no gas deducted");
    assert((await balance(G1)) === g1Before && (await balance(G2)) === g2Before, "guardians spent no gas");
    log("heirs and guardians paid zero gas");

    await expectError("NO_ROLE", () => sponsoredCall(account(G3), relayer, C, "claim", { owner }, 100));
    await expectError("METHOD_NOT_SPONSORED", () => sponsoredCall(account(owner), relayer, C, "withdraw", { amount: "1" }));
  },

  /** Authorization negatives on live testnet. */
  async "authorization"() {
    const owner = await overduePlan("auth");
    await expectError("E_NOT_GUARDIAN", () => call(AMARA, C, "propose_release", { owner, eth_balance: null }));
    await proposeAndApprove(owner);
    await expectError("E_PROPOSAL_OPEN", () => call(owner, C, "set_plan", { plan: demoPlan() }, { deposit: nearToYocto("0.05") }));
    await expectError("E_PROPOSAL_OPEN", () => call(owner, C, "withdraw", { amount: "1" }));
    await expectError("E_UNAUTHORIZED", () => call(AMARA, C, "report_broadcast", { owner, index: 0, tx_hash: "0x00" }));
    await expectError("E_UNAUTHORIZED", () => call(owner, C, "set_paused", { paused: true }));
    await call(owner, C, "cancel_release", {});
  },
};

const wanted = process.argv.slice(2);
const run = wanted.length ? wanted : Object.keys(scenarios);
let failed = 0;
for (const name of run) {
  const fn = scenarios[name];
  if (!fn) throw new Error(`unknown scenario ${name}; have ${Object.keys(scenarios).join(", ")}`);
  console.log(`\n=== ${name} ===`);
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${String((e as Error)?.message ?? e)}`);
  }
}
void provider;
process.exit(failed ? 1 : 0);
