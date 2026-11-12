// Live D28 + D29 demo: an edit notice for high-impact edits, and guardian
// recovery that never lowers the quorum. Demo timers: 1-minute notice,
// availability window and swap delay.
//
//   1. A fresh owner (Standard tier) saves a plan with guardians G1–G3
//      (quorum 2), one standby (Tobi), availability checks and a 1-minute
//      edit notice.
//   2. Cooling-off: changing the heir's destination is queued, not applied;
//      applying early fails (E_CHANGE_NOT_DUE); the owner cancels it.
//      Queued again with a request to turn the notice off, both wait it out
//      and a guardian (anyone) applies them.
//   3. Availability: G3 stays quiet past the window; a heir asks for the
//      standby; finishing early fails; G3 confirms and the swap is off.
//      G3 goes quiet again; the swap lands after the delay. Quorum stays 2.
//      With the old guardians quiet too, the status says quorum is
//      unreachable until they confirm.
//   4. Rotation: G1 moves its seat to a new account; the owner cancels the
//      first request; the second lands after the delay.
//   5. Resignation with no standby left: the seat stays, resigned; it can't
//      confirm or vote; quorum unchanged.
// Usage: pnpm --filter @behest/testnet e2e-recovery
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, nearToYocto } from "near-api-js";
import { account, call, loadDeployment, log, payTier, reclaimScenarioOwners, view, waitForKey } from "./near.js";
import { ensureScenarioFunds } from "./funding.js";

const d = loadDeployment();
await reclaimScenarioOwners(d.contract, d.owner);
await ensureScenarioFunds(d, 0.3);
const C = d.contract;
const [G1, G2, G3] = d.guardians as [string, string, string];
const [AMARA, TOBI] = d.heirs as [string, string];
const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
/** Views can trail the last transaction by a block or two: re-read until `ok` holds (or fail). */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => unknown, msg: string): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await read();
    if (ok(v)) return v;
    if (i >= 10) throw new Error(`assertion failed: ${msg}`);
    await sleep(1_500);
  }
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

interface Pending { change: Record<string, unknown>; queued_at_ms: number; effective_at_ms: number }
interface Seat { account_id: string; last_seen_ms: number | null; available: boolean; resigned: boolean; replaceable: boolean }
interface Status { quorum: number; available: number; quorum_reachable: boolean; guardians: Seat[]; standbys: Seat[]; pending: { kind: string; out: string; into: string; effective_at_ms: number }[] }
interface PlanView { now_ms: number; plan: { version: number; policy: { quorum: number; guardians: string[]; heirs: { near_destination: string | null }[] } } }
const plan = (owner: string) => view<PlanView>(C, "get_plan", { owner });
const pending = (owner: string) => view<Pending[]>(C, "get_pending_changes", { owner });
const status = (owner: string) => view<Status>(C, "get_guardian_status", { owner });
const kinds = (p: Pending[]) => p.map((c) => Object.keys(c.change)[0]);
/** Waits until the chain clock passes `ms` (block time, not ours). */
async function until(owner: string, ms: number, why: string) {
  log(`waiting: ${why}`);
  for (;;) {
    const now = (await plan(owner)).now_ms;
    if (now >= ms) return;
    await sleep(Math.min(15_000, ms - now + 2_000));
  }
}

const policy = (dest: string) => ({
  check_in_interval_ms: 60 * MINUTE,
  grace_ms: 0,
  waiting_period_ms: MINUTE,
  guardians: [G1, G2, G3],
  quorum: 2,
  heirs: [{ account_id: AMARA, share_bps: 10_000, near_destination: dest, eth_destination: null }],
});

// ------------------------------------------------------------------ setup
const kp = KeyPair.fromRandom("ed25519");
const sub = `rec${Date.now().toString(36)}`;
const owner = `${sub}.${d.owner}`;
await account(d.owner).createSubAccount({ accountOrPrefix: sub, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.3") });
await waitForKey(owner, kp.getPublicKey().toString());
const dir = join(homedir(), ".near-credentials/testnet");
mkdirSync(dir, { recursive: true });
const saveKey = (id: string) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
saveKey(owner);
// G1's new key: a sub-account of the owner (any account works).
const ROT = `g1new.${owner}`;
await account(owner).createSubAccount({ accountOrPrefix: "g1new", publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto("0.05") });
await waitForKey(ROT, kp.getPublicKey().toString());
saveKey(ROT);
log("owner", { owner, rotateTo: ROT });

// 1. Standard plan, standby, availability checks, edit notice.
await payTier(C, owner, 1, d.admin);
await call(owner, C, "set_plan", { plan: policy(AMARA) }, { deposit: nearToYocto("0.05") });
await call(owner, C, "set_guardian_settings", { settings: { standbys: [TOBI], availability_ms: MINUTE, swap_delay_ms: MINUTE } }, { deposit: nearToYocto("0.01") });
await call(owner, C, "set_edit_notice", { notice_ms: MINUTE }, { deposit: nearToYocto("0.01") });
assert((await view<number>(C, "get_edit_notice", { owner })) === MINUTE, "notice saved");
let st = await eventually(() => status(owner), (x) => x.standbys[0]?.account_id === TOBI && x.quorum_reachable, "standby listed, quorum reachable");
log("1. plan, standby and 1-minute edit notice saved");

// 2. Cooling-off.
const v0 = (await plan(owner)).plan.version;
await call(owner, C, "set_plan", { plan: policy(d.admin) }, { deposit: nearToYocto("0.05") });
await eventually(() => pending(owner), (x) => kinds(x).join() === "Plan", "queued as a Plan change");
let p = await plan(owner);
assert(p.plan.policy.heirs[0]!.near_destination === AMARA, "the new destination waits out the notice");
await expectError("E_CHANGE_NOT_DUE", () => call(G1, C, "apply_changes", { owner, kind: null }));
await call(owner, C, "cancel_change", { kind: "Plan" });
await eventually(() => pending(owner), (x) => x.length === 0, "cancelled");
await call(owner, C, "set_plan", { plan: policy(d.admin) }, { deposit: nearToYocto("0.05") });
await call(owner, C, "set_edit_notice", { notice_ms: 0 }, { deposit: nearToYocto("0.01") });
await eventually(() => pending(owner), (x) => kinds(x).join() === "Plan,Notice", "plan change and notice removal both queued");
assert((await view<number>(C, "get_edit_notice", { owner })) === MINUTE, "the notice still applies until then");
const due = Math.max(...(await pending(owner)).map((c) => c.effective_at_ms));
await until(owner, due, "edit notice");
const applied = await call(G1, C, "apply_changes", { owner, kind: null });
p = await eventually(() => plan(owner), (x) => x.plan.policy.heirs[0]!.near_destination === d.admin && x.plan.version > v0, "applied by a guardian");
await eventually(async () => [await view<number>(C, "get_edit_notice", { owner }), (await pending(owner)).length], ([n, k]) => n === 0 && k === 0, "notice off, nothing pending");
log("2. queued, cancelled, re-queued and applied after the notice", { applied: String(applied ?? "") });

// 3. Availability and a standby swap.
for (const g of [G1, G2, TOBI]) await call(g, C, "confirm_guardian", { owner });
const seen = (await status(owner)).guardians.find((g) => g.account_id === G3)!.last_seen_ms!;
await until(owner, seen + MINUTE + 1_000, "G3 past the availability window");
await call(TOBI, C, "confirm_guardian", { owner });
await call(AMARA, C, "request_standby", { owner, guardian: G3 });
st = await eventually(() => status(owner), (x) => x.pending[0]?.out === G3 && x.pending[0]?.into === TOBI, "standby requested for G3");
await expectError("E_CHANGE_NOT_DUE", () => call(AMARA, C, "finalize_guardian_change", { owner, guardian: G3 }));
await call(G3, C, "confirm_guardian", { owner });
await eventually(() => status(owner), (x) => x.pending.length === 0, "G3 confirmed: swap called off");
log("3a. standby requested, then called off when G3 confirmed");
await until(owner, (await plan(owner)).now_ms + MINUTE + 1_000, "G3 quiet again");
await call(TOBI, C, "confirm_guardian", { owner });
await call(AMARA, C, "request_standby", { owner, guardian: G3 });
await until(owner, (await eventually(() => status(owner), (x) => x.pending.length === 1, "requested again")).pending[0]!.effective_at_ms, "swap delay");
await call(AMARA, C, "finalize_guardian_change", { owner, guardian: G3 });
p = await eventually(() => plan(owner), (x) => x.plan.policy.guardians.join() === [G1, G2, TOBI].join() && x.plan.policy.quorum === 2, "Tobi holds G3's seat; quorum still 2");
st = await eventually(() => status(owner), (x) => x.guardians[2]?.account_id === TOBI, "status caught up");
assert(st.standbys.length === 0, "standby used");
if (!st.quorum_reachable) {
  log("3b. G1 and G2 quiet too: quorum reported unreachable", { available: st.available, quorum: st.quorum });
  for (const g of [G1, G2]) await call(g, C, "confirm_guardian", { owner });
}
st = await eventually(() => status(owner), (x) => x.quorum_reachable, "reachable once guardians confirm");
log("3. standby took the unresponsive seat after the delay; quorum unchanged");

// 4. Rotation.
await call(G1, C, "rotate_guardian", { owner, new_account: ROT });
await call(owner, C, "cancel_guardian_change", { owner, guardian: G1 });
await eventually(() => status(owner), (x) => x.pending.length === 0, "owner cancelled the rotation");
await call(G1, C, "rotate_guardian", { owner, new_account: ROT });
await expectError("E_CHANGE_NOT_DUE", () => call(G2, C, "finalize_guardian_change", { owner, guardian: G1 }));
await until(owner, (await eventually(() => status(owner), (x) => x.pending.length === 1, "rotation requested")).pending[0]!.effective_at_ms, "rotation delay");
await call(G2, C, "finalize_guardian_change", { owner, guardian: G1 });
p = await eventually(() => plan(owner), (x) => x.plan.policy.guardians[0] === ROT, "G1's seat moved to the new account");
await expectError("E_NOT_GUARDIAN", () => call(G1, C, "confirm_guardian", { owner }));
await call(ROT, C, "confirm_guardian", { owner });
log("4. G1 rotated its seat (one request cancelled by the owner)");

// 5. Resignation with no standby left.
await call(G2, C, "resign_guardian", { owner });
st = await eventually(() => status(owner), (x) => x.guardians.find((g) => g.account_id === G2)?.resigned === true, "G2 resigned");
p = await plan(owner);
assert(p.plan.policy.guardians.length === 3 && p.plan.policy.quorum === 2, "seat count and quorum unchanged");
await expectError("E_GUARDIAN_RESIGNED", () => call(G2, C, "confirm_guardian", { owner }));
log("5. G2 resigned with no standby: seat kept, marked resigned", { available: st.available, quorum: st.quorum, reachable: st.quorum_reachable });

log("e2e-recovery passed", { owner, guardians: p.plan.policy.guardians });
