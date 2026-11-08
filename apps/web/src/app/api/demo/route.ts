// Creates a "Try as…" sandbox: six funded testnet accounts under the demo
// funder, one per persona. The browser sends only public keys; private keys
// never reach this server. Testnet only, rate-limited, small amounts.
import { Account, JsonRpcProvider, nearToYocto, type KeyPairString } from "near-api-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ROLES = ["owner", "g1", "g2", "g3", "amara", "tobi"] as const;
// Owner pays plan storage and a 0.2 NEAR escrow; the others only need their
// own storage because the relayer pays their gas.
const FUNDING: Record<(typeof ROLES)[number], string> = { owner: "0.4", g1: "0.01", g2: "0.01", g3: "0.01", amara: "0.01", tobi: "0.01" };
const PER_IP_PER_HOUR = 3;
const PER_DAY = 30;

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

export async function POST(req: Request) {
  const funderId = process.env.DEMO_FUNDER_ACCOUNT_ID;
  const funderKey = process.env.DEMO_FUNDER_PRIVATE_KEY;
  if (!funderId || !funderKey || !funderId.endsWith(".testnet")) {
    return NextResponse.json({ error: "Demo personas aren't configured on this server." }, { status: 503 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allow(ip)) return NextResponse.json({ error: "Too many sandboxes from here; try again in an hour." }, { status: 429 });

  const body = (await req.json().catch(() => null)) as { publicKeys?: Record<string, string> } | null;
  const keys = body?.publicKeys ?? {};
  for (const r of ROLES) {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(keys[r] ?? "")) return NextResponse.json({ error: `bad public key for ${r}` }, { status: 400 });
  }

  const funder = new Account(funderId, new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" }), funderKey as KeyPairString);
  const tag = Math.random().toString(36).slice(2, 7);
  const accounts: Record<string, string> = {};
  try {
    for (const r of ROLES) {
      const prefix = `${tag}-${r}`;
      await funder.createSubAccount({ accountOrPrefix: prefix, publicKey: keys[r]!, nearToTransfer: nearToYocto(FUNDING[r] as `${number}`) });
      accounts[r] = `${prefix}.${funderId}`;
    }
  } catch (e) {
    console.error("demo sandbox failed", e);
    return NextResponse.json({ error: "Couldn't create test accounts (the demo funder may be out of testnet NEAR)." }, { status: 502 });
  }
  return NextResponse.json({ accounts });
}
