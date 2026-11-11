// Live D26 demo: DAOs in every role, through real SputnikDAO v2 contracts made
// by sputnikv2.testnet (the factory Trezu's DAOs come from on mainnet).
//
//   Owner DAO (fresh each run; council: the owner parent + guardian 3)
//     1. pays its Complete tier with a proposal calling the USDC token's
//        ft_transfer_call {"pay_tier": <dao>}, from the DAO's own USDC;
//     2. creates its plan in one proposal: set_plan (storage deposit) +
//        deposit (escrow) + set_release_options (Automatic) +
//        set_checkin_delegates([council member]), all deposits from the DAO;
//   3. a delegate (a council member, signing alone) checks in for the DAO;
//      a delegate can't withdraw and, once a release is open, can't check in;
//   4. the deadline passes; guardian 3 proposes a release and the guardian
//      DAO (council: guardians 1 and 2) approves it through its own proposal;
//   5. after the waiting period the executor pays the heir DAO (council: the
//      two heirs) automatically; nobody at the heir DAO signs anything.
//
// The guardian and heir DAOs are created once and kept in the deployment file.
// Usage: pnpm --filter @behest/testnet e2e-dao
import { nearToYocto } from "near-api-js";
import { ensureFunds } from "./funding.js";
import { account, call, loadDeployment, log, provider, saveDeployment, view } from "./near.js";
import { executor } from "./sepolia.js";

const FACTORY = process.env.SPUTNIK_FACTORY || "sputnikv2.testnet";
const BOND = nearToYocto("0.1");
const DAO_DEPOSIT = nearToYocto("6");
const MINUTE = 60_000;

const d = loadDeployment();
const C = d.contract;
const [G1, G2, G3] = d.guardians as [string, string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const OWNER_COUNCIL = [d.owner, G3];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } })).amount);
const exists = (id: string) => balance(id).then(() => true, () => false);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

interface Transfer { heir: string; amount: string; state: string; destination: string }
interface PlanView { status: string; overdue_at_ms: number; now_ms: number; plan: { owner: string; last_check_in_ms: number; escrow: string; proposal: null | { id: number; waiting_ends_at_ms: number | null; transfers: Transfer[] } } }
const plan = (owner: string) => view<PlanView | null>(C, "get_plan", { owner });
async function waitChain(owner: string, target: number) {
  for (let p = (await plan(owner))!; p.now_ms < target; p = (await plan(owner))!) await sleep(Math.min(target - p.now_ms + 2_000, 15_000));
}

// --------------------------------------------------------------- sputnik
/** A DAO whose council (Group role, all permissions) needs more than half the votes; 0.1 NEAR bond, 1 hour to vote. */
async function createDao(name: string, council: string[], creator: string) {
  const id = `${name}.${FACTORY}`;
  if (await exists(id)) return id;
  const policy = {
    roles: [{ name: "council", kind: { Group: council }, permissions: ["*:*"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: BOND.toString(),
    proposal_period: (60n * 60n * 1_000_000_000n).toString(),
    bounty_bond: BOND.toString(),
    bounty_forgiveness_period: (24n * 60n * 60n * 1_000_000_000n).toString(),
  };
  await call(creator, FACTORY, "create", { name, args: b64({ config: { name, purpose: "Behest D26 end-to-end test", metadata: "" }, policy }) }, { tgas: 300, deposit: DAO_DEPOSIT });
  assert(await exists(id), `${id} created`);
  log("DAO created", { id, council });
  return id;
}

interface Action { method: string; args: Record<string, unknown>; deposit?: bigint; tgas?: number }
interface Proposal { id: number; status: string; votes: Record<string, string> }

/** member proposes `actions` on `receiver` as the DAO; returns the proposal id. */
async function propose(dao: string, member: string, receiver: string, description: string, actions: Action[]) {
  await call(member, dao, "add_proposal", {
    proposal: {
      description: `${description} · via Behest`,
      kind: { FunctionCall: { receiver_id: receiver, actions: actions.map((a) => ({ method_name: a.method, args: b64(a.args), deposit: (a.deposit ?? 0n).toString(), gas: (BigInt(a.tgas ?? 40) * 10n ** 12n).toString() })) } },
    },
  }, { tgas: 50, deposit: BOND });
  return (await view<number>(dao, "get_last_proposal_id")) - 1;
}

/** Every council member votes yes; the last vote runs the call. Fails unless it ends Approved. */
async function pass(dao: string, id: number, council: string[]) {
  for (const m of council) {
    const p = await view<Proposal>(dao, "get_proposal", { id });
    if (p.status !== "InProgress") break;
    await call(m, dao, "act_proposal", { id, action: "VoteApprove", memo: "e2e" }, { tgas: 300 });
  }
  const p = await view<Proposal>(dao, "get_proposal", { id });
  assert(p.status === "Approved", `proposal ${dao}#${id} approved (is ${p.status})`);
}

// ------------------------------------------------------------------ setup
const saved = d as typeof d & { daos?: { guardian: string; heir: string } };
const suffix = C.split(".")[0]!.replace(/^behest-/, "");
const needNew = !saved.daos || !(await exists(saved.daos.guardian)) || !(await exists(saved.daos.heir));
// The owner DAO is fresh each run (≈6 NEAR of storage, from the owner parent); the others are made once.
await ensureFunds({ [d.owner]: 8 + (needNew ? 13 : 0), [G1]: 1, [G2]: 1, [G3]: 1, [d.admin]: 1, [d.executor]: 1 });
const guardDao = await createDao(`bg-${suffix}`, [G1, G2], d.owner);
const heirDao = await createDao(`bh-${suffix}`, [AMARA, TOBI], d.owner);
if (!saved.daos) {
  saved.daos = { guardian: guardDao, heir: heirDao };
  saveDeployment(saved);
}
const ownerDao = await createDao(`bo${Date.now().toString(36)}`, OWNER_COUNCIL, d.owner);
// Running money for the plan: storage deposit, escrow, and the options/delegates storage.
await account(d.owner).transfer({ receiverId: ownerDao, amount: nearToYocto("1") });

// ------------------------------------------------ 1. the DAO pays its tier
const cfg = await view<{ fee_token: string | null; tiers: { price: string }[] }>(C, "get_tier_config");
assert(cfg.fee_token, "tiers are on");
const price = BigInt(cfg.tiers[2]!.price);
await call(d.admin, cfg.fee_token, "mint", { account_id: ownerDao, amount: price.toString() });
const usdcBefore = BigInt(await view<string>(cfg.fee_token, "ft_balance_of", { account_id: ownerDao }));
const payId = await propose(ownerDao, d.owner, cfg.fee_token, "Pay the Behest plan tier for this DAO (Complete)", [
  { method: "ft_transfer_call", args: { receiver_id: C, amount: price.toString(), msg: JSON.stringify({ pay_tier: ownerDao }) }, deposit: 1n, tgas: 100 },
]);
await pass(ownerDao, payId, OWNER_COUNCIL);
const t = await view<{ tier: number; paid: string }>(C, "get_tier", { owner: ownerDao });
assert(t.tier === 2 && BigInt(t.paid) === price, `the DAO's own USDC paid Complete (tier ${t.tier}, paid ${t.paid})`);
assert(BigInt(await view<string>(cfg.fee_token, "ft_balance_of", { account_id: ownerDao })) === usdcBefore - price, "the USDC left the DAO");
log("1. owner DAO paid its tier by proposal", { dao: ownerDao, proposal: payId, tier: "Complete" });

// --------------------------------- 2. the DAO creates its plan, one proposal
const ESCROW = nearToYocto("0.3");
const delegate = OWNER_COUNCIL[1]!;
const planId = await propose(ownerDao, d.owner, C, "Save the DAO's inheritance plan, then fund it, set Automatic release and name a check-in delegate", [
  {
    method: "set_plan",
    args: {
      plan: {
        check_in_interval_ms: 3 * MINUTE,
        grace_ms: 0,
        waiting_period_ms: MINUTE,
        guardians: [G3, guardDao],
        quorum: 2,
        heirs: [{ account_id: heirDao, share_bps: 10_000, near_destination: heirDao, eth_destination: null }],
      },
    },
    deposit: nearToYocto("0.1"),
  },
  { method: "deposit", args: { owner: ownerDao }, deposit: ESCROW, tgas: 20 },
  { method: "set_release_options", args: { options: { mode: "Automatic", hybrid_grace_ms: 0, delay_signers: [], delay_quorum: 0, max_extension_ms: 0, max_total_extension_ms: 0, overrides: [] } }, deposit: nearToYocto("0.01"), tgas: 30 },
  { method: "set_checkin_delegates", args: { delegates: [delegate] }, deposit: nearToYocto("0.01"), tgas: 30 },
]);
await pass(ownerDao, planId, OWNER_COUNCIL);
let p = (await plan(ownerDao))!;
assert(p && p.plan.owner === ownerDao && BigInt(p.plan.escrow) === ESCROW, "the DAO owns a funded plan");
assert((await view<string[]>(C, "get_checkin_delegates", { owner: ownerDao })).join() === delegate, "delegate named");
assert((await view<{ mode: string } | null>(C, "get_release_options", { owner: ownerDao }))?.mode === "Automatic", "automatic release");
log("2. owner DAO created its plan by proposal", { proposal: planId, escrow: "0.3 NEAR", guardians: [G3, guardDao], heir: heirDao, delegate });

// ------------------------------------------------- 3. a delegate checks in
await sleep(5_000);
const lastBefore = p.plan.last_check_in_ms;
await call(delegate, C, "check_in", { owner: ownerDao });
p = (await plan(ownerDao))!;
assert(p.plan.last_check_in_ms > lastBefore, "the delegate's check-in restarted the clock");
const stranger = await call(G1, C, "check_in", { owner: ownerDao }).then(() => "ok", (e) => String(e));
assert(stranger.includes("E_NOT_DELEGATE"), `a non-delegate is refused (${stranger.slice(0, 80)})`);
const grab = await call(delegate, C, "withdraw", { amount: "1" }).then(() => "ok", (e) => String(e));
assert(grab.includes("E_NO_PLAN") || grab.includes("E_INSUFFICIENT_ESCROW"), `a delegate can't withdraw from the DAO's plan (${grab.slice(0, 80)})`);
log("3. delegate checked in for the DAO with one signature; a stranger and a withdrawal were refused");

// ------------------------- 4. deadline passes; the guardian DAO approves
log("waiting for the DAO's plan to become overdue", { at: new Date(p.overdue_at_ms).toISOString() });
await waitChain(ownerDao, p.overdue_at_ms + 1_000);
await call(G3, C, "propose_release", { owner: ownerDao });
const releaseId = (await plan(ownerDao))!.plan.proposal!.id;
const approveId = await propose(guardDao, G1, C, `Approve release #${releaseId} of ${ownerDao}'s plan`, [{ method: "approve_release", args: { owner: ownerDao, proposal_id: releaseId }, tgas: 50 }]);
await pass(guardDao, approveId, [G1, G2]);
p = (await plan(ownerDao))!;
assert(p.status === "Waiting", `guardian DAO's approval reached quorum (status ${p.status})`);
const late = await call(delegate, C, "check_in", { owner: ownerDao }).then(() => "ok", (e) => String(e));
assert(late.includes("E_PROPOSAL_OPEN"), `a delegate can't cancel an open release (${late.slice(0, 80)})`);
log("4. guardian DAO approved the release by proposal; the delegate could not cancel it", { release: releaseId, daoProposal: approveId });

// --------------------------------- 5. the heir DAO is paid automatically
const heirBefore = await balance(heirDao);
await waitChain(ownerDao, p.plan.proposal!.waiting_ends_at_ms! + 1_000);
const engine = executor(C, d.executor);
const stateOf = (v: PlanView) => v.plan.proposal?.transfers.find((x) => x.heir === heirDao);
for (let i = 0; i < 20; i++) {
  await engine.tick();
  p = (await plan(ownerDao))!;
  const tr = stateOf(p);
  if (!p.plan.proposal || tr?.state === "Confirmed") break;
  await sleep(3_000);
}
const heirAfter = await balance(heirDao);
const got = heirAfter - heirBefore;
assert(got === ESCROW, `heir DAO received the whole escrow (${got})`);
log("5. heir DAO was paid automatically; it signed nothing", { heir: heirDao, received: "0.3 NEAR" });
log("e2e-dao passed", { ownerDao, guardDao, heirDao });
