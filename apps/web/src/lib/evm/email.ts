"use client";
// Signing in with an email address (Privy). The address gets a code; whoever
// enters it holds the Ethereum, NEAR and Bitcoin wallets Privy keeps for that
// address — the same ones the notifier hands out when an owner names someone
// by email, so a heir who has never used a wallet arrives already holding the
// account the plan names.
//
// To Behest it is one more Ethereum wallet (D23): the 0x address signs readable
// messages with personal_sign and the relayer submits them. The NEAR and
// Bitcoin keys only matter after a payout, to move what arrived somewhere else.
//
// Loaded on demand: nobody pays for this module until they pick email.
import type PrivyClient from "@privy-io/js-sdk-core";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { hexToBytes, stringToHex, type Hex } from "viem";
import { CONTRACT_ID, NOTIFIER_URL } from "../config";
import type { Eip1193, EvmConnection, WalletInfo } from "./wallets";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const EMAIL_WALLET: WalletInfo = { id: "email", name: "Email", kind: "email" };

/** The other two wallets of an email account, and how to sign with them. */
export interface EmailWallet {
  email: string;
  /** NEAR implicit account (64 hex chars; the ed25519 key itself). */
  near: string;
  /** SegWit address on this deployment's Bitcoin network, and its compressed public key (hex). */
  btc: string;
  btcPublicKey: string;
  /** ed25519 signature (64 bytes) over a 32-byte hash, by the NEAR key. */
  signNear(hash: Uint8Array): Promise<Uint8Array>;
  /** secp256k1 signature (r || s, 64 bytes) over a 32-byte hash, by the Bitcoin key. */
  signBtc(hash: Uint8Array): Promise<Uint8Array>;
  /** The Ethereum wallet as an EIP-1193 provider (eth_signTransaction for moving ETH out). */
  ethProvider(): Promise<Eip1193>;
}

export interface EmailConnection extends EvmConnection {
  email: EmailWallet;
}

export class EmailError extends Error {
  constructor(
    public code: "NOT_SET_UP" | "BAD_CODE" | "TOO_MANY" | "NO_WALLET" | "UNREACHABLE",
    message: string,
  ) {
    super(message);
  }
}

interface Account {
  type: string;
  address?: string;
  chain_type?: string;
  id?: string | null;
  public_key?: string | null;
  wallet_client_type?: string;
}
interface User {
  id: string;
  linked_accounts: Account[];
}

const toHex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;

/** P2WPKH address of a compressed public key on this deployment's Bitcoin network. */
export function segwitAddress(publicKeyHex: string, mainnet = CONTRACT_ID.endsWith(".near")): string {
  return bech32.encode(mainnet ? "bc" : "tb", [0, ...bech32.toWords(ripemd160(sha256(hexToBytes(`0x${publicKeyHex.replace(/^0x/, "")}`))))]);
}

// ---------------------------------------------------------------- the client

interface Loaded {
  privy: PrivyClient;
  sdk: typeof import("@privy-io/js-sdk-core");
}
let loaded: Promise<Loaded> | null = null;

/** Privy's client plus the hidden frame that holds the signed-in person's signing key. */
function load(): Promise<Loaded> {
  if (!PRIVY_APP_ID) return Promise.reject(new EmailError("NOT_SET_UP", "Email sign-in isn't set up on this deployment."));
  if (!loaded) {
    const p = (async () => {
      const sdk = await import("@privy-io/js-sdk-core");
      const privy = new sdk.default({ appId: PRIVY_APP_ID, storage: new sdk.LocalStorage() });
      const frame = document.createElement("iframe");
      frame.src = privy.embeddedWallet.getURL();
      frame.title = "Sign-in";
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
      document.body.appendChild(frame);
      privy.setMessagePoster({
        postMessage: (m, origin, transfer) => frame.contentWindow?.postMessage(m, origin, transfer ? [transfer] : undefined),
        reload: () => frame.contentWindow?.location.reload(),
      });
      // Only the frame's own messages reach the client.
      window.addEventListener("message", (e) => {
        if (e.source === frame.contentWindow) privy.embeddedWallet.onMessage(e.data);
      });
      await privy.initialize();
      return { privy, sdk };
    })();
    p.catch(() => {
      if (loaded === p) loaded = null;
    });
    loaded = p;
  }
  return loaded;
}

const embedded = (u: User, chain: string) => u.linked_accounts.find((a) => a.type === "wallet" && a.chain_type === chain && a.wallet_client_type === "privy");
const emailOf = (u: User) => u.linked_accounts.find((a) => a.type === "email")?.address ?? "";

function privyError(e: unknown): Error {
  const m = String((e as { message?: string })?.message ?? e);
  // Only a refusal that is about the code itself may blame the code.
  if (/invalid email and code|(invalid|incorrect|wrong|expired)[^.]{0,20}code|code[^.]{0,20}(invalid|incorrect|expired|used)/i.test(m)) return new EmailError("BAD_CODE", "That code didn't work. Use the newest email, or send a new code.");
  if (/too many|rate limit|429/i.test(m)) return new EmailError("TOO_MANY", "Too many tries. Wait a minute, then send a new code.");
  if (/failed to fetch|network|timeout|timed out/i.test(m)) return new EmailError("UNREACHABLE", "Couldn't reach the sign-in service. Check your connection and try again.");
  return new Error(`Sign-in didn't go through (${m.slice(0, 160)}). Send a new code and try again.`);
}

const CHAINS = ["ethereum", "near", "bitcoin-segwit"] as const;
const lacks = (u: User) => CHAINS.filter((c) => !embedded(u, c));
const askNotifier = (email: string) => fetch(`${NOTIFIER_URL.replace(/\/$/, "")}/v1/email-wallets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).then((r) => r.ok, () => false);

/**
 * A first-time address signs in to an account with no wallets yet. They are
 * normally made before the code is even sent (by the notifier); if that didn't
 * happen, ask again, and failing that create whatever is missing as the
 * signed-in person. Returns the user as it stands afterwards.
 */
async function withWallets(l: Loaded, email: string, user: User): Promise<User> {
  if (!lacks(user).length) return user;
  if (await askNotifier(email)) user = (await l.privy.user.get()).user as unknown as User;
  const missing = lacks(user);
  if (!missing.length) return user;
  for (const chain_type of missing) {
    await l.sdk.create(l.privy, { request: { chain_type, owner: { user_id: user.id } } as never }).catch(() => {});
  }
  return (await l.privy.user.get()).user as unknown as User;
}

function connection({ privy, sdk }: Loaded, user: User): EmailConnection {
  const eth = embedded(user, "ethereum");
  const near = embedded(user, "near");
  const btc = embedded(user, "bitcoin-segwit");
  if (!eth?.address || !near?.address || !near.id || !btc?.id || !btc.public_key)
    throw new EmailError("NO_WALLET", "Your code was right, but the account for this address couldn't be finished just now: the service that sets it up didn't answer. Nothing is lost. Try again in a few minutes.");
  const address = eth.address.toLowerCase() as Hex;
  const authorize = (i: { message: string }) => privy.embeddedWallet.signWithUserSigner(i);
  const raw = async (walletId: string, hash: Uint8Array) => {
    const r = await sdk.rawSign(privy, authorize, { wallet_id: walletId, params: { hash: toHex(hash) } });
    return hexToBytes(r.data.signature as Hex);
  };
  const provider = async () => {
    const entropy = sdk.getEntropyDetailsFromUser(user as never);
    if (!entropy) throw new EmailError("NO_WALLET", "This email's account isn't fully set up yet.");
    return (await privy.embeddedWallet.getEthereumProvider({ wallet: eth as never, ...entropy })) as unknown as Eip1193;
  };
  return {
    wallet: EMAIL_WALLET,
    address,
    async sign(message) {
      let sig: unknown;
      try {
        sig = await (await provider()).request({ method: "personal_sign", params: [stringToHex(message), address] });
      } catch (e) {
        throw privyError(e);
      }
      if (typeof sig !== "string" || sig.length !== 132) throw new Error("The sign-in service returned something that isn't a signature.");
      return sig as Hex;
    },
    // One account per email; nothing changes underneath a session.
    onAccountChange: () => () => {},
    async disconnect() {
      await privy.auth.logout().catch(() => {});
    },
    email: {
      email: emailOf(user),
      near: near.address,
      btcPublicKey: btc.public_key,
      btc: segwitAddress(btc.public_key),
      signNear: (hash) => raw(near.id!, hash),
      signBtc: (hash) => raw(btc.id!, hash),
      ethProvider: provider,
    },
  };
}

// ---------------------------------------------------------------- sign-in

/** Makes sure the address has its wallets (a first-time address has none yet), then emails it a code. */
export async function sendCode(email: string): Promise<void> {
  const { privy } = await load();
  // A sign-in left half-done in this browser would make the next code fail for no visible reason.
  if (await privy.getAccessToken().catch(() => null)) await privy.auth.logout().catch(() => {});
  // Without this a brand-new address would sign in to an account with no wallets. Best effort:
  // someone an owner already named has them, and sign-in fills any gap itself (see withWallets).
  await askNotifier(email);
  try {
    await privy.auth.email.sendCode(email);
  } catch (e) {
    throw privyError(e);
  }
}

/** Finishes sign-in with the emailed code. */
export async function loginWithCode(email: string, code: string): Promise<EmailConnection> {
  const l = await load();
  let user: User;
  try {
    user = (await l.privy.auth.email.loginWithCode(email, code.trim())).user as unknown as User;
  } catch (e) {
    throw privyError(e);
  }
  try {
    return connection(l, await withWallets(l, email, user));
  } catch (e) {
    // Don't stay signed in to an account that can't act: the next attempt must start clean, with a new code.
    await l.privy.auth.logout().catch(() => {});
    throw e;
  }
}

/** The email session kept in this browser, if it is still signed in as `address`. No prompt. */
export async function restore(address: string): Promise<EmailConnection | null> {
  if (!PRIVY_APP_ID) return null;
  try {
    const l = await load();
    if (!(await l.privy.getAccessToken())) return null;
    const user = (await l.privy.user.get()).user as unknown as User;
    const c = connection(l, await withWallets(l, emailOf(user), user));
    return c.address === address.toLowerCase() ? c : null;
  } catch {
    return null;
  }
}
