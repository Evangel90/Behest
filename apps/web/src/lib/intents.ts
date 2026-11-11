// D25 on mainnet: pay a tier with almost any asset on almost any chain through
// NEAR Intents' 1Click API. The swap delivers exactly the USDC due to the
// Behest contract with ft_transfer_call and msg {"pay_tier": owner}
// (customRecipientMsg), so the contract credits the owner like any payment.
// Mainnet only: 1Click has no testnet. Deposits that can't be filled are
// refunded by 1Click to `refundTo` on the origin chain.
import { CONTRACT_ID } from "./config";
import { base64Encode, baseEncode } from "near-api-js";
import { view } from "./contract";
import { signNep413 } from "./notify";
import type { Session } from "./session";
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

// ---------------------------------------------------------------- D27
// Heirs can receive through NEAR Intents: the contract pays their share into
// their account inside the Intents verifier (intents.near on mainnet, a mock
// on testnet). From there they can hold it, swap it to almost any asset on
// almost any chain, or withdraw it. Heirs' swaps carry no Behest fee: no
// appFees are ever set here (D25 promises fees never touch releases).

export interface IntentsConfig {
  verifier: string;
  wnear: string;
}
export interface IntentsDelivery {
  account_id: string;
  enabled: boolean;
  intents_account: string | null;
}
export interface IntentsProgress {
  paid: string;
  wrapped: string;
}

export const getIntentsConfig = () => view<IntentsConfig | null>("get_intents_config");
export const getIntentsDelivery = (owner: string) => view<IntentsDelivery[]>("get_intents_delivery", { owner });
export const getIntentsProgress = (owner: string, index: number) => view<IntentsProgress>("get_intents_progress", { owner, index });

/** The Intents account a recipient is paid into, or null when they're paid to their wallet. */
export function intentsTarget(deliveries: IntentsDelivery[], recipient: string, nearDestination?: string | null): string | null {
  const d = deliveries.find((x) => x.account_id === recipient && x.enabled);
  return d ? (d.intents_account ?? nearDestination ?? d.account_id) : null;
}

/** Balances inside Intents for the given NEP-141 tokens (`nep141:<token>` ids), via mt_batch_balance_of. */
export async function intentsBalances(verifier: string, account: string, tokens: string[]): Promise<Record<string, bigint>> {
  if (!tokens.length) return {};
  const ids = tokens.map((t) => `nep141:${t}`);
  const out = await view<string[]>("mt_batch_balance_of", { account_id: account, token_ids: ids }, verifier);
  return Object.fromEntries(tokens.map((t, i) => [t, BigInt(out[i] ?? "0")]));
}

/**
 * A quote that spends from the heir's Intents balance (depositType INTENTS):
 * the heir moves `amount` of `origin` inside Intents to the returned deposit
 * address with a signed transfer intent, and 1Click delivers `dest` to
 * `recipient` on its chain. Refunds go back to the Intents account. No appFees.
 */
export async function intentsQuote(opts: { origin: string; dest: IntentToken; amount: bigint; intentsAccount: string; recipient: string; dry?: boolean }): Promise<IntentQuote> {
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const res = await fetch(`${API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: !!opts.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: opts.origin,
      depositType: "INTENTS",
      destinationAsset: opts.dest.assetId,
      amount: opts.amount.toString(),
      refundTo: opts.intentsAccount,
      refundType: "INTENTS",
      recipient: opts.recipient.trim(),
      recipientType: "DESTINATION_CHAIN",
      deadline,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { quote?: Partial<IntentQuote> & { amountOutFormatted?: string }; message?: string };
  if (!res.ok || !body.quote) throw new Error(body.message ? `NEAR Intents: ${body.message}` : "NEAR Intents couldn't quote this.");
  return { depositAddress: "", amountIn: "0", amountInFormatted: "0", amountInUsd: "0", timeEstimate: 0, ...body.quote, deadline } as IntentQuote;
}

/** The intents a heir signs: move tokens to a 1Click deposit address, or withdraw to a NEAR account. */
export type HeirIntent =
  | { intent: "transfer"; receiver_id: string; tokens: Record<string, string> }
  | { intent: "ft_withdraw"; token: string; receiver_id: string; amount: string };

export type SignedIntent =
  | { standard: "nep413"; payload: { message: string; nonce: string; recipient: string }; public_key: string; signature: string }
  | { standard: "erc191"; payload: string; signature: string };

/**
 * Signs intents as the heir's Intents account. NEAR wallets and test personas
 * sign NEP-413 (recipient: the verifier); Ethereum wallets sign ERC-191
 * (personal_sign) over the same JSON with the verifier and nonce inside.
 */
export async function signIntents(session: Session, verifier: string, intents: HeirIntent[], deadlineMs = Date.now() + 10 * 60_000): Promise<SignedIntent> {
  const deadline = new Date(deadlineMs).toISOString();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  if (session.kind === "evm") {
    if (!session.personalSign) throw new Error("Reconnect your wallet, then try again.");
    const payload = JSON.stringify({ signer_id: session.accountId, verifying_contract: verifier, deadline, nonce: base64Encode(nonce), intents });
    const hex = (await session.personalSign(payload)).replace(/^0x/, "");
    const sig = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    // The verifier wants the recovery id as 0 or 1.
    if (sig[64]! >= 27) sig[64] = sig[64]! - 27;
    return { standard: "erc191", payload, signature: `secp256k1:${baseEncode(sig)}` };
  }
  const message = JSON.stringify({ signer_id: session.accountId, deadline, intents });
  const s = await signNep413(session, message, verifier, nonce);
  const sig = Uint8Array.from(atob(s.signature), (c) => c.charCodeAt(0));
  return { standard: "nep413", payload: { message, nonce: s.nonce, recipient: verifier }, public_key: s.publicKey, signature: `ed25519:${baseEncode(sig)}` };
}

const SOLVER_RELAY = "https://solver-relay-v2.chaindefuser.com/rpc";

/** Publishes a signed intent to the solver relay (mainnet). */
export async function publishIntent(signed: SignedIntent): Promise<string> {
  const res = await fetch(SOLVER_RELAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "publish_intent", params: [{ quote_hashes: [], signed_data: signed }] }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: { status?: string; intent_hash?: string; reason?: string }; error?: { message?: string } };
  if (!res.ok || body.error || body.result?.status !== "OK") throw new Error(`NEAR Intents refused it: ${body.error?.message ?? body.result?.reason ?? res.status}`);
  return body.result.intent_hash ?? "";
}

/**
 * Mainnet: an Intents deposit address on another chain that credits
 * `account` inside Intents (the PoA bridge). Saved as a heir's normal
 * Ethereum or Bitcoin destination, the vault's payout lands in Intents.
 * Testnet has no bridge.
 */
export async function bridgeDepositAddress(account: string, chain: "eth:1" | "btc:mainnet"): Promise<string> {
  if (!intentsAvailable) throw new Error("NEAR Intents' bridge is mainnet-only.");
  const res = await fetch("https://bridge.chaindefuser.com/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "deposit_address", params: [{ account_id: account, chain }] }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: { address?: string }; error?: { message?: string } };
  if (!res.ok || !body.result?.address) throw new Error(body.error?.message ?? "The Intents bridge didn't give an address.");
  return body.result.address;
}
