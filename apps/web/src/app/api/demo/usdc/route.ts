// Testnet only: pays a plan tier (D25) in test USDC for an owner who has no
// NEAR to call the faucet with (an Ethereum-wallet owner, typically). The demo
// funder mints the amount still due from the mock token's public faucet and
// pays it with ft_transfer_call naming the owner, exactly as anyone may.
// Rate-limited; mainnet has no faucet and this route refuses to run there.
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { NextResponse } from "next/server";
import { CONTRACT_ID } from "@/lib/config";

export const runtime = "nodejs";

const PER_IP_PER_HOUR = 5;
const PER_DAY = 100;
const hits = new Map<string, number[]>();
let day = { start: 0, count: 0 };

function allow(ip: string): boolean {
  const now = Date.now();
  if (now - day.start > 86_400_000) day = { start: now, count: 0 };
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_IP_PER_HOUR || day.count >= PER_DAY) return false;
  hits.set(ip, [...recent, now]);
  day.count++;
  return true;
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export async function POST(req: Request) {
  const funderId = process.env.DEMO_FUNDER_ACCOUNT_ID;
  const funderKey = process.env.DEMO_FUNDER_PRIVATE_KEY;
  if (!funderId || !funderKey || !funderId.endsWith(".testnet") || !CONTRACT_ID.endsWith(".testnet")) {
    return NextResponse.json({ error: "The test USDC faucet isn't configured on this server." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { owner?: string; tier?: number } | null;
  const owner = body?.owner?.trim().toLowerCase() ?? "";
  const tier = Number(body?.tier);
  if (owner.length < 2 || owner.length > 64 || !ACCOUNT.test(owner)) return NextResponse.json({ error: "That isn't a NEAR account." }, { status: 400 });
  if (!Number.isInteger(tier) || tier < 1 || tier > 7) return NextResponse.json({ error: "Pick a paid tier." }, { status: 400 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allow(ip)) return NextResponse.json({ error: "The test faucet has paid enough from here for now; try again in an hour." }, { status: 429 });

  const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
  const funder = new Account(funderId, provider, funderKey as KeyPairString);
  try {
    const cfg = (await provider.callFunction({ contractId: CONTRACT_ID, method: "get_tier_config", args: {} })) as { fee_token: string | null; fee_decimals: number };
    if (!cfg.fee_token) return NextResponse.json({ error: "Tiers aren't switched on for this contract." }, { status: 409 });
    const t = (await provider.callFunction({ contractId: CONTRACT_ID, method: "get_tier", args: { owner } })) as { due: string[]; paid: string };
    let due = BigInt(t.due[tier] ?? "0");
    if (due === 0n) return NextResponse.json({ error: "That tier is already paid for." }, { status: 409 });
    const one = 10n ** BigInt(cfg.fee_decimals);
    if (BigInt(t.paid) === 0n && due < one) due = one;
    for (let left = due; left > 0n; ) {
      const n = left > 500_000_000n ? 500_000_000n : left;
      await funder.callFunction({ contractId: cfg.fee_token, methodName: "mint", args: { account_id: funderId, amount: n.toString() }, gas: teraToGas(30) });
      left -= n;
    }
    await funder.callFunction({
      contractId: cfg.fee_token,
      methodName: "ft_transfer_call",
      args: { receiver_id: CONTRACT_ID, amount: due.toString(), msg: JSON.stringify({ pay_tier: owner }) },
      gas: teraToGas(80),
      deposit: 1n,
    });
    const after = (await provider.callFunction({ contractId: CONTRACT_ID, method: "get_tier", args: { owner } })) as { tier: number };
    if (after.tier < tier) return NextResponse.json({ error: "The payment was refunded by the contract." }, { status: 502 });
    return NextResponse.json({ tier: after.tier, amount: due.toString() });
  } catch (e) {
    console.error("test USDC payment failed", e);
    return NextResponse.json({ error: "The test faucet couldn't pay (the demo funder may be out of testnet NEAR)." }, { status: 502 });
  }
}
