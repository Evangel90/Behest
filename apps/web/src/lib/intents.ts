// D25 on mainnet: pay a tier with almost any asset on almost any chain through
// NEAR Intents' 1Click API. The swap delivers exactly the USDC due to the
// Behest contract with ft_transfer_call and msg {"pay_tier": owner}
// (customRecipientMsg), so the contract credits the owner like any payment.
// Mainnet only: 1Click has no testnet. Deposits that can't be filled are
// refunded by 1Click to `refundTo` on the origin chain.
import { CONTRACT_ID } from "./config";
import { paymentMsg } from "./tiers";

const API = "https://1click.chaindefuser.com/v0";

export interface IntentToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
}

export interface IntentQuote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  timeEstimate: number;
  deadline: string;
}

export type IntentStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";

export const intentsAvailable = CONTRACT_ID.endsWith(".near");

/** Chains people most often hold value on, shown first. */
const POPULAR = ["eth", "base", "arb", "btc", "sol", "near", "pol", "op", "bsc"];

export async function intentTokens(): Promise<IntentToken[]> {
  const res = await fetch(`${API}/tokens`);
  if (!res.ok) throw new Error("NEAR Intents is unreachable right now.");
  const all = (await res.json()) as IntentToken[];
  return all
    .filter((t) => t.assetId.startsWith("nep141:") && ["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR", "NEAR"].includes(t.symbol))
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
}

const rank = (t: IntentToken) => {
  const i = POPULAR.indexOf(t.blockchain);
  return i < 0 ? POPULAR.length : i;
};

/** USDC on NEAR as 1Click names it, matched to the contract's fee token. */
export async function feeAsset(feeToken: string): Promise<IntentToken> {
  const res = await fetch(`${API}/tokens`);
  const all = (await res.json()) as IntentToken[];
  const t = all.find((x) => x.blockchain === "near" && x.contractAddress === feeToken);
  if (!t) throw new Error("NEAR Intents doesn't route to Behest's fee token.");
  return t;
}

/**
 * A live quote: send `amountIn` of `origin` to `depositAddress` before the
 * deadline and `amount` of the fee token arrives at Behest for `owner`.
 */
export async function quote(opts: { origin: IntentToken; feeToken: string; amount: bigint; owner: string; refundTo: string; dry?: boolean }): Promise<IntentQuote> {
  const dest = await feeAsset(opts.feeToken);
  const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
  const res = await fetch(`${API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: !!opts.dry,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: opts.origin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: dest.assetId,
      amount: opts.amount.toString(),
      refundTo: opts.refundTo.trim(),
      refundType: "ORIGIN_CHAIN",
      recipient: CONTRACT_ID,
      recipientType: "DESTINATION_CHAIN",
      customRecipientMsg: paymentMsg(opts.owner),
      deadline,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { quote?: Partial<IntentQuote>; message?: string };
  if (!res.ok || !body.quote) throw new Error(body.message ? `NEAR Intents: ${body.message}` : "NEAR Intents couldn't quote this.");
  return { depositAddress: "", amountIn: "0", amountInFormatted: "0", amountInUsd: "0", timeEstimate: 0, ...body.quote, deadline } as IntentQuote;
}

export async function status(depositAddress: string): Promise<IntentStatus> {
  const res = await fetch(`${API}/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  if (!res.ok) return "PENDING_DEPOSIT";
  const body = (await res.json()) as { status?: IntentStatus };
  return body.status ?? "PENDING_DEPOSIT";
}

export const STATUS_WORDS: Record<IntentStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Deposit seen, waiting for confirmations",
  PROCESSING: "Swapping to USDC and paying Behest",
  SUCCESS: "Paid. Your tier is updated.",
  INCOMPLETE_DEPOSIT: "The deposit was short. Send the rest or wait for the refund.",
  REFUNDED: "Refunded to your address. Nothing was paid.",
  FAILED: "The swap failed. Funds are refunded to your address.",
};
