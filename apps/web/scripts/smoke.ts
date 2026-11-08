// Live smoke test of the web app's own signing layer (no browser needed):
// creates a "Try as…" sandbox through /api/demo, then runs the full release
// with personaSession(), checking guardian and heir calls are gas-sponsored.
// Needs `pnpm start` (or dev) on :3000 and the relayer running.
// Usage: pnpm --filter @behest/web smoke
import { getPlan } from "../src/lib/contract";
import { PERSONA_INFO, PERSONA_ROLES, heirWallet, type Persona, type PersonaRole } from "../src/lib/demo";
import { newKeyPair, personaSession } from "../src/lib/session";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, d?: unknown) => console.log(`• ${m}`, d === undefined ? "" : JSON.stringify(d));
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${m}`);
}

const keys = Object.fromEntries(PERSONA_ROLES.map((r) => [r, newKeyPair()])) as Record<PersonaRole, ReturnType<typeof newKeyPair>>;
const res = await fetch(`${APP}/api/demo`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ publicKeys: Object.fromEntries(PERSONA_ROLES.map((r) => [r, keys[r].publicKey])) }),
});
const body = (await res.json()) as { accounts?: Record<PersonaRole, string>; error?: string };
assert(res.ok && body.accounts, `sandbox: ${res.status} ${body.error}`);
const P = Object.fromEntries(PERSONA_ROLES.map((r) => [r, { role: r, accountId: body.accounts![r], secretKey: keys[r].secretKey, ...PERSONA_INFO[r] } satisfies Persona])) as Record<PersonaRole, Persona>;
const S = Object.fromEntries(PERSONA_ROLES.map((r) => [r, personaSession(P[r])])) as Record<PersonaRole, ReturnType<typeof personaSession>>;
const owner = P.owner.accountId;
log("sandbox created", body.accounts);

await S.owner.call("set_plan", {
  plan: {
    check_in_interval_ms: MIN, grace_ms: 0, waiting_period_ms: MIN,
    guardians: [P.g1.accountId, P.g2.accountId, P.g3.accountId], quorum: 2,
    heirs: [
      { account_id: P.amara.accountId, share_bps: 6000, near_destination: P.amara.accountId, eth_destination: heirWallet().address.toLowerCase() },
      { account_id: P.tobi.accountId, share_bps: 4000, near_destination: P.tobi.accountId, eth_destination: null },
    ],
  },
}, { deposit: 50_000_000_000_000_000_000_000n });
await S.owner.call("deposit", { owner }, { deposit: 200_000_000_000_000_000_000_000n });
log("plan set and funded by owner");

const until = async (status: string) => {
  for (let i = 0; i < 60; i++) {
    const v = await getPlan(owner);
    if (v?.status === status) return v;
    await sleep(5_000);
  }
  throw new Error(`never reached ${status}`);
};
await until("Overdue");
const r1 = await S.g1.call("propose_release", { owner, eth_balance: null });
const id = (await getPlan(owner))!.plan.proposal!.id;
const r2 = await S.g2.call("approve_release", { owner, proposal_id: id });
assert(r1.sponsored && r2.sponsored, "guardian calls sponsored");
log("guardians proposed and approved (sponsored)");

await until("Eligible");
const c1 = await S.amara.call("claim", { owner }, { tgas: 300 });
const c2 = await S.tobi.call("claim", { owner }, { tgas: 300 });
assert(c1.sponsored && c2.sponsored, "heir claims sponsored");
const done = await until("Settled");
log("settled", done.plan.proposal!.transfers.map((t) => `${t.heir.split("-")[1]} ${t.asset} ${t.state}`));
console.log("✓ web signing layer: sandbox → plan → sponsored votes → sponsored claims → Settled");
