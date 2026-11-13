// Moving what a heir received out of the account kept for their email, to a
// wallet or exchange of their choice. The keys stay with the sign-in service
// (see evm/email): for Ethereum it signs a whole transaction; for NEAR and
// Bitcoin it only signs a hash, so the transaction is built, checked and
// broadcast here. Everything on this page spends the heir's own money, so
// each function refuses anything it can't fully account for.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bech32, bech32m } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, Signature, SignedTransaction, actions, baseDecode, baseEncode, createTransaction } from "near-api-js";
import { encodeFunctionData, erc20Abi, hexToBytes, isAddress, numberToHex, type Hex } from "viem";
import { BTC_ESPLORA, CONTRACT_ID } from "./config";
import { btcUtxos, provider, sepoliaClient, view } from "./contract";
import type { EmailWallet } from "./evm/email";
import type { Erc20Token, Nep141Token } from "./types";

export class SendError extends Error {}

const mainnet = CONTRACT_ID.endsWith(".near");

// ------------------------------------------------------------------ NEAR

/** Left behind on "send everything": covers this transfer's network fee with room to spare. */
export const NEAR_FEE_RESERVE = 1_000_000_000_000_000_000_000n; // 0.001 NEAR
const TGAS = 1_000_000_000_000n;
/** A token transfer prepays 45 Tgas; the account needs that much NEAR on hand (most is refunded). */
export const NEAR_TOKEN_FEE_RESERVE = 5_000_000_000_000_000_000_000n; // 0.005 NEAR

const nearKey = (account: string) => PublicKey.fromString(`ed25519:${baseEncode(hexToBytes(`0x${account}`))}`);

/** A destination that can receive NEAR: an existing account, or an implicit one (created on arrival). */
export async function checkNearDestination(to: string): Promise<string | null> {
  const a = to.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-f]{40}$/.test(a)) return null;
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a) || a.length < 2 || a.length > 64) return "That doesn't look like a NEAR account.";
  try {
    await provider.viewAccount({ accountId: a });
    return null;
  } catch (e) {
    return /does not exist|UNKNOWN_ACCOUNT/i.test(String(e)) ? `${a} doesn't exist on NEAR ${mainnet ? "mainnet" : "testnet"}. Check the spelling: sending to a missing account fails.` : "Couldn't check that account just now. Try again.";
  }
}

async function nearSend(w: EmailWallet, receiverId: string, acts: ReturnType<typeof actions.transfer>[]): Promise<string> {
  const publicKey = nearKey(w.near);
  let nonce: bigint;
  try {
    nonce = BigInt((await provider.viewAccessKey({ accountId: w.near, publicKey })).nonce) + 1n;
  } catch {
    throw new SendError("This NEAR account has never received anything, so there is nothing to send yet.");
  }
  const block = await provider.viewBlock({ finality: "final" });
  const tx = createTransaction(w.near, publicKey, receiverId, nonce, acts, baseDecode(block.header.hash));
  const signature = await w.signNear(sha256(tx.encode()));
  if (signature.length !== 64) throw new SendError("The sign-in service returned something that isn't a signature.");
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: signature }) });
  const out = (await provider.sendTransaction(signed)) as { transaction?: { hash?: string }; status?: unknown };
  const status = JSON.stringify(out.status ?? {});
  if (status.includes("Failure")) throw new SendError(`The NEAR network refused the transfer: ${status.slice(0, 200)}`);
  return out.transaction?.hash ?? "";
}

/** Sends `yocto` NEAR from the email account's NEAR account. Returns the transaction hash. */
export async function sendNear(w: EmailWallet, to: string, yocto: bigint): Promise<string> {
  const dest = to.trim().toLowerCase();
  const bad = await checkNearDestination(dest);
  if (bad) throw new SendError(bad);
  if (dest === w.near) throw new SendError("That's this same account.");
  if (yocto <= 0n) throw new SendError("Enter an amount.");
  return nearSend(w, dest, [actions.transfer(yocto)]);
}

export const nep141Balance = (token: string, account: string) => view<string>("ft_balance_of", { account_id: account }, token).then(BigInt, () => 0n);

/** Sends NEAR tokens (NEP-141), registering the receiver with the token first if it isn't yet. */
export async function sendNep141(w: EmailWallet, token: Nep141Token, to: string, amount: bigint): Promise<string> {
  const dest = to.trim().toLowerCase();
  const bad = await checkNearDestination(dest);
  if (bad) throw new SendError(bad);
  if (amount <= 0n) throw new SendError("Enter an amount.");
  const registered = await view<{ total: string } | null>("storage_balance_of", { account_id: dest }, token.account_id).catch(() => null);
  const acts = [
    ...(registered ? [] : [actions.functionCall("storage_deposit", { account_id: dest, registration_only: true }, 15n * TGAS, BigInt(token.storage_deposit))]),
    actions.functionCall("ft_transfer", { receiver_id: dest, amount: amount.toString() }, 30n * TGAS, 1n),
  ];
  return nearSend(w, token.account_id, acts);
}

// ------------------------------------------------------------------ Ethereum

export interface EthFee {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The most this transfer can cost in wei. */
  max: bigint;
}

/** Fee for a plain ETH transfer, or for an ERC-20 transfer when `token` is given. */
export async function ethFee(from: Hex, to: Hex, token?: { address: Hex; amount: bigint }): Promise<EthFee> {
  const fees = await sepoliaClient.estimateFeesPerGas();
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1_500_000_000n;
  // Headroom for a few rising blocks; what isn't used stays in the account.
  const maxFeePerGas = (fees.maxFeePerGas ?? 3_000_000_000n) * 2n;
  const gas = token ? ((await sepoliaClient.estimateGas({ account: from, to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, token.amount] }) })) * 12n) / 10n : 21_000n;
  return { gas, maxFeePerGas, maxPriorityFeePerGas, max: gas * maxFeePerGas };
}

async function ethSend(w: EmailWallet, from: Hex, tx: { to: Hex; value: bigint; data?: Hex }, fee: EthFee): Promise<Hex> {
  const [nonce, chainId] = await Promise.all([sepoliaClient.getTransactionCount({ address: from, blockTag: "pending" }), sepoliaClient.getChainId()]);
  const request = {
    from,
    to: tx.to,
    value: numberToHex(tx.value),
    data: tx.data ?? "0x",
    nonce: numberToHex(nonce),
    gas: numberToHex(fee.gas),
    gasLimit: numberToHex(fee.gas),
    maxFeePerGas: numberToHex(fee.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(fee.maxPriorityFeePerGas),
    chainId: numberToHex(chainId),
    type: 2,
  };
  const raw = await (await w.ethProvider()).request({ method: "eth_signTransaction", params: [request] });
  if (typeof raw !== "string" || !raw.startsWith("0x")) throw new SendError("The sign-in service returned something that isn't a transaction.");
  return sepoliaClient.sendRawTransaction({ serializedTransaction: raw as Hex });
}

/** Sends `wei` ETH from the email account's Ethereum address. Returns the transaction hash. */
export async function sendEth(w: EmailWallet, from: Hex, to: string, wei: bigint, fee: EthFee): Promise<Hex> {
  if (!isAddress(to.trim())) throw new SendError("An Ethereum address is 0x followed by 40 characters.");
  if (wei <= 0n) throw new SendError("Enter an amount.");
  const balance = await sepoliaClient.getBalance({ address: from });
  if (wei + fee.max > balance) throw new SendError("That's more than the account holds once the network fee is set aside.");
  return ethSend(w, from, { to: to.trim() as Hex, value: wei }, fee);
}

/** Sends ERC-20 tokens; the network fee is paid in ETH from the same address. */
export async function sendErc20(w: EmailWallet, from: Hex, token: Erc20Token, to: string, amount: bigint, fee: EthFee): Promise<Hex> {
  if (!isAddress(to.trim())) throw new SendError("An Ethereum address is 0x followed by 40 characters.");
  if (amount <= 0n) throw new SendError("Enter an amount.");
  if ((await sepoliaClient.getBalance({ address: from })) < fee.max) throw new SendError("This address needs a little ETH to pay the network fee for a token transfer.");
  return ethSend(w, from, { to: token.address as Hex, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to.trim() as Hex, amount] }) }, fee);
}

// ------------------------------------------------------------------ Bitcoin

const NET = mainnet ? btc.NETWORK : btc.TEST_NETWORK;
/** Below this an output is "dust": nodes won't relay it. */
const DUST = 546n;
/** Sizes in virtual bytes of a P2WPKH spend: fixed part, each input, each output (the largest kind, Taproot). */
const VB = { base: 11, input: 68, output: 43 };

/** A SegWit address on this deployment's Bitcoin network (bc1…/tb1…), or why not. */
export function checkBtcAddress(address: string): string | null {
  const a = address.trim();
  const want = mainnet ? "bc" : "tb";
  try {
    let decoded: { prefix: string; words: number[] };
    try {
      decoded = bech32.decode(a as `${string}1${string}`, 90);
      if (decoded.words[0] !== 0) throw new Error("not v0");
    } catch {
      decoded = bech32m.decode(a as `${string}1${string}`, 90);
      if (decoded.words[0] === 0) throw new Error("v0 must be bech32");
    }
    if (decoded.prefix !== want) return mainnet ? "That's a testnet address; this is real Bitcoin." : "That's a mainnet address. Behest runs on Bitcoin testnet here, so use an address starting with tb1.";
    btc.Address(NET).decode(a);
    return null;
  } catch {
    return /^[13mn2]/.test(a) ? "Older address formats aren't supported. Use one starting with " + want + "1." : `That doesn't look like a Bitcoin address (they start with ${want}1).`;
  }
}

export interface BtcPlan {
  inputs: { txid: string; vout: number; value: bigint }[];
  /** What the receiver gets, the miner fee, and what comes back to this address. */
  amount: bigint;
  fee: bigint;
  change: bigint;
  feeRate: number;
  total: bigint;
}

/** Fee rate in sat/vB for confirmation within a few blocks (never below 1). */
export async function btcFeeRate(): Promise<number> {
  try {
    const r = await fetch(`${BTC_ESPLORA}/fee-estimates`);
    const est = (await r.json()) as Record<string, number>;
    return Math.max(1, Math.ceil(est["3"] ?? est["6"] ?? 1));
  } catch {
    return mainnet ? 10 : 2;
  }
}

/**
 * Chooses coins for a payment. `amount` null means "everything": one output,
 * no change. Throws SendError when the coins can't cover amount + fee.
 */
export function planBtc(utxos: { txid: string; vout: number; value: string }[], amount: bigint | null, feeRate: number): BtcPlan {
  const coins = utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) })).sort((a, b) => (b.value > a.value ? 1 : -1));
  const total = coins.reduce((s, c) => s + c.value, 0n);
  if (!coins.length) throw new SendError("No confirmed bitcoin here yet. A payment shows up once it has one confirmation.");
  const feeFor = (inputs: number, outputs: number) => BigInt(Math.ceil((VB.base + VB.input * inputs + VB.output * outputs) * feeRate));
  if (amount === null) {
    const fee = feeFor(coins.length, 1);
    if (total - fee < DUST) throw new SendError("There's too little here to send: the network fee would use it up.");
    return { inputs: coins, amount: total - fee, fee, change: 0n, feeRate, total };
  }
  if (amount < DUST) throw new SendError(`The smallest amount Bitcoin will relay is ${DUST} sats.`);
  const inputs: typeof coins = [];
  let sum = 0n;
  for (const c of coins) {
    inputs.push(c);
    sum += c.value;
    const withChange = feeFor(inputs.length, 2);
    if (sum >= amount + withChange + DUST) return { inputs, amount, fee: withChange, change: sum - amount - withChange, feeRate, total };
    // Too little left over for a change output worth having: it goes to the fee.
    const noChange = feeFor(inputs.length, 1);
    if (sum >= amount + noChange && sum - amount - noChange < DUST + (withChange - noChange)) return { inputs, amount, fee: sum - amount, change: 0n, feeRate, total };
  }
  throw new SendError("That's more than this address holds once the network fee is set aside. Use “Send everything” to empty it.");
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const big = (b: Uint8Array) => BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") || "0"}`);
function derInt(n: bigint): number[] {
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  const bytes = Array.from(hexToBytes(`0x${h}`));
  return bytes[0]! & 0x80 ? [0, ...bytes] : bytes;
}
/** r || s (64 bytes) as a DER signature with a low S, as Bitcoin requires. */
export function derSignature(rs: Uint8Array): Uint8Array {
  if (rs.length !== 64) throw new SendError("The sign-in service returned something that isn't a signature.");
  const r = big(rs.slice(0, 32));
  let s = big(rs.slice(32));
  if (s > N / 2n) s = N - s;
  if (r === 0n || s === 0n) throw new SendError("The sign-in service returned an invalid signature.");
  const R = derInt(r);
  const S = derInt(s);
  return Uint8Array.from([0x30, R.length + S.length + 4, 0x02, R.length, ...R, 0x02, S.length, ...S]);
}

/** Builds and signs a payment from the email account's Bitcoin address. Returns the raw transaction (hex) and its id. */
export async function buildBtc(w: Pick<EmailWallet, "btc" | "btcPublicKey" | "signBtc">, to: string, plan: BtcPlan): Promise<{ hex: string; txid: string }> {
  const bad = checkBtcAddress(to);
  if (bad) throw new SendError(bad);
  const pubkey = hexToBytes(`0x${w.btcPublicKey}`);
  const me = btc.p2wpkh(pubkey, NET);
  if (me.address !== w.btc) throw new SendError("This account's Bitcoin key doesn't match its address.");
  const tx = new btc.Transaction();
  for (const i of plan.inputs) tx.addInput({ txid: i.txid, index: i.vout, witnessUtxo: { script: me.script, amount: i.value }, sequence: 0xfffffffd });
  tx.addOutputAddress(to.trim(), plan.amount, NET);
  if (plan.change > 0n) tx.addOutputAddress(w.btc, plan.change, NET);
  // A P2WPKH input is signed over the BIP143 digest of its pay-to-pubkey-hash script.
  const scriptCode = btc.OutScript.encode({ type: "pkh", hash: ripemd160(sha256(pubkey)) });
  for (let i = 0; i < plan.inputs.length; i++) {
    const digest = tx.preimageWitnessV0(i, scriptCode, btc.SigHash.ALL, plan.inputs[i]!.value);
    const sig = derSignature(await w.signBtc(digest));
    // A signature that doesn't verify would make a transaction the network rejects; stop here instead.
    if (!secp256k1.verify(sig, digest, pubkey, { prehash: false, format: "der" })) throw new SendError("The sign-in service's signature doesn't match this account's Bitcoin key. Nothing was sent.");
    tx.updateInput(i, { partialSig: [[pubkey, Uint8Array.from([...sig, btc.SigHash.ALL])]] }, true);
  }
  tx.finalize();
  // The library re-derives the fee from inputs and outputs: it must be the one that was shown.
  if (tx.fee !== plan.fee) throw new SendError("The transaction's fee doesn't match what was shown. Nothing was sent.");
  return { hex: tx.hex, txid: tx.id };
}

export async function broadcastBtc(hex: string): Promise<string> {
  const r = await fetch(`${BTC_ESPLORA}/tx`, { method: "POST", body: hex });
  const text = await r.text();
  if (!r.ok) throw new SendError(`The Bitcoin network refused the transaction: ${text.slice(0, 200)}`);
  return text.trim();
}

/** Sends bitcoin: `sats` null empties the address. Returns the transaction id. */
export async function sendBtc(w: EmailWallet, to: string, sats: bigint | null, feeRate: number): Promise<string> {
  const plan = planBtc(await btcUtxos(w.btc), sats, feeRate);
  const { hex } = await buildBtc(w, to, plan);
  return broadcastBtc(hex);
}
