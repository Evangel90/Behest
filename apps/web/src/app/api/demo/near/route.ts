// Testnet only: adds 0.2 test NEAR to a plan's escrow from the demo funder,
// for owners with no NEAR wallet (an Ethereum-wallet or social-login owner,
// typically). The funder calls `deposit({owner})`, as anyone may. Rate-limited;
// refuses to run against a mainnet contract.
import { Account, JsonRpcProvider, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { NextResponse } from "next/server";
import { CONTRACT_ID } from "@/lib/config";

export const runtime = "nodejs";

const AMOUNT = "0.2";
const PER_IP_PER_HOUR = 5;
const PER_OWNER_PER_DAY = 3;
const PER_DAY = 100;
const ips = new Map<string, number[]>();
const owners = new Map<string, number[]>();
let day = { start: 0, count: 0 };

function allow(map: Map<string, number[]>, key: string, windowMs: number, max: number, now: number) {
  const recent = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return false;
  map.set(key, [...recent, now]);
  return true;
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export async function POST(req: Request) {
  const funderId = process.env.DEMO_FUNDER_ACCOUNT_ID;
  const funderKey = process.env.DEMO_FUNDER_PRIVATE_KEY;
  if (!funderId || !funderKey || !funderId.endsWith(".testnet") || !CONTRACT_ID.endsWith(".testnet")) {
    return NextResponse.json({ error: "The test NEAR faucet isn't configured on this server." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { owner?: string } | null;
  const owner = body?.owner?.trim().toLowerCase() ?? "";
  if (owner.length < 2 || owner.length > 64 || !ACCOUNT.test(owner)) return NextResponse.json({ error: "That isn't a NEAR account." }, { status: 400 });
  const now = Date.now();
  if (now - day.start > 86_400_000) day = { start: now, count: 0 };
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (day.count >= PER_DAY || !allow(ips, ip, 3_600_000, PER_IP_PER_HOUR, now)) return NextResponse.json({ error: "The test faucet has sent enough from here for now; try again in an hour." }, { status: 429 });
  if (!allow(owners, owner, 86_400_000, PER_OWNER_PER_DAY, now)) return NextResponse.json({ error: "This plan got test NEAR three times today; try again tomorrow." }, { status: 429 });

  const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
  try {
    const plan = (await provider.callFunction({ contractId: CONTRACT_ID, method: "get_plan", args: { owner } })) as { plan: { proposal: unknown } } | null;
    if (!plan) return NextResponse.json({ error: "There's no plan for that account yet." }, { status: 404 });
    if (plan.plan.proposal) return NextResponse.json({ error: "NEAR can't be added while a release is open." }, { status: 409 });
    day.count++;
    const funder = new Account(funderId, provider, funderKey as KeyPairString);
    await funder.callFunction({ contractId: CONTRACT_ID, methodName: "deposit", args: { owner }, gas: teraToGas(30), deposit: nearToYocto(AMOUNT) });
    return NextResponse.json({ amount: AMOUNT });
  } catch (e) {
    console.error("test NEAR faucet failed", e);
    return NextResponse.json({ error: "The test faucet couldn't add NEAR (the demo funder may be out of testnet NEAR)." }, { status: 502 });
  }
}
