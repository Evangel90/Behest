"use client";
// Ethereum wallets inside the app (D23): browser extensions found through
// EIP-6963 (MetaMask, Rabby, Coinbase Wallet…) and phone wallets through
// WalletConnect. They only ever sign messages (personal_sign); Behest's
// relayer submits them, so no chain, RPC or gas is involved on the wallet side.
// Loaded on demand: the landing page never pays for this module.
import { isHex, recoverMessageAddress, stringToHex, type Hex } from "viem";
import type UniversalProvider from "@walletconnect/universal-provider";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, fn: (...a: never[]) => void): void;
  removeListener?(event: string, fn: (...a: never[]) => void): void;
}

export interface WalletInfo {
  /** EIP-6963 rdns (e.g. "io.metamask"), "injected" for a legacy window.ethereum, or "walletconnect". */
  id: string;
  name: string;
  /** data: URI from the wallet's announcement. */
  icon?: string;
  kind: "injected" | "walletconnect";
}

export const WALLETCONNECT: WalletInfo = { id: "walletconnect", name: "WalletConnect", kind: "walletconnect" };
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

// ------------------------------------------------------------ discovery (EIP-6963)

interface Announced {
  info: WalletInfo;
  provider: Eip1193;
}
const found = new Map<string, Announced>();
const listeners = new Set<() => void>();
let listening = false;

function onAnnounce(e: Event) {
  const d = (e as CustomEvent<{ info?: { rdns?: string; name?: string; icon?: string; uuid?: string }; provider?: Eip1193 }>).detail;
  const id = d?.info?.rdns || d?.info?.uuid;
  if (!id || !d?.provider || typeof d.provider.request !== "function") return;
  found.set(id, { info: { id, name: d.info?.name || "Browser wallet", icon: safeIcon(d.info?.icon), kind: "injected" }, provider: d.provider });
  listeners.forEach((f) => f());
}

// Only data: images, so an announcement can't make the page load a remote URL.
const safeIcon = (s?: string) => (s && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(s) ? s : undefined);

/** Starts listening for wallet announcements and asks wallets to announce. Returns an unsubscribe. */
export function watchWallets(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (!listening) {
    listening = true;
    window.addEventListener("eip6963:announceProvider", onAnnounce);
  }
  listeners.add(onChange);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => void listeners.delete(onChange);
}

/** Wallets announced so far; a lone pre-EIP-6963 `window.ethereum` if none announced. */
export function injectedWallets(): Announced[] {
  const list = [...found.values()];
  if (list.length) return list;
  const legacy = typeof window !== "undefined" ? (window as { ethereum?: Eip1193 }).ethereum : undefined;
  return legacy && typeof legacy.request === "function" ? [{ info: { id: "injected", name: "Browser wallet", kind: "injected" }, provider: legacy }] : [];
}

/** Waits briefly for a particular wallet to announce itself (extensions inject after the page). */
async function findInjected(id: string, waitMs = 1200): Promise<Announced | null> {
  const has = () => injectedWallets().find((w) => w.info.id === id) ?? null;
  if (has()) return has();
  return new Promise((resolve) => {
    // Announcements can arrive synchronously, inside watchWallets itself.
    let done = false;
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      stop();
      clearTimeout(timer);
      resolve(has());
    };
    stop = watchWallets(() => has() && finish());
    if (done) stop();
    else timer = setTimeout(finish, waitMs);
  });
}

// ------------------------------------------------------------ connections

export interface EvmConnection {
  wallet: WalletInfo;
  /** Lowercase 0x address. */
  address: Hex;
  /** EIP-191 personal_sign of UTF-8 text; checked locally to recover to `address`. */
  sign(message: string): Promise<Hex>;
  /** Account switched in the wallet (null: the wallet disconnected the site). */
  onAccountChange(fn: (address: Hex | null) => void): () => void;
  /** Ends the wallet's link to this site where the wallet supports it. */
  disconnect(): Promise<void>;
}

export class WalletError extends Error {
  constructor(
    public code: "PENDING" | "REJECTED" | "NO_ACCOUNT" | "NOT_FOUND" | "NO_PROJECT" | "SMART_ACCOUNT" | "WRONG_SIGNER" | "BUSY",
    message: string,
  ) {
    super(message);
  }
}

const lower = (a: string) => a.toLowerCase() as Hex;
const firstAccount = (r: unknown): Hex | null => (Array.isArray(r) && typeof r[0] === "string" && /^0x[0-9a-fA-F]{40}$/.test(r[0]) ? lower(r[0]) : null);

/** Maps wallet RPC errors to plain words. */
function walletError(e: unknown, wallet: WalletInfo): Error {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? "")) return new WalletError("REJECTED", "You cancelled in your wallet. Nothing was sent.");
  if (err?.code === -32002 || /already pending|previous request is still active/i.test(err?.message ?? ""))
    return new WalletError("PENDING", `${wallet.name} is already waiting for you. Open it from your browser's toolbar to finish.`);
  return e instanceof Error ? e : new Error(String(err?.message ?? e));
}

/** Checks a signature before it leaves the browser: ordinary 65-byte ECDSA, from this address. */
async function checked(message: string, sig: unknown, address: Hex, wallet: WalletInfo): Promise<Hex> {
  if (typeof sig !== "string" || !isHex(sig)) throw new Error(`${wallet.name} returned something that isn't a signature.`);
  if (sig.length !== 132)
    throw new WalletError("SMART_ACCOUNT", `${wallet.name} signed as a smart-contract account. Behest can only check signatures from an ordinary Ethereum account; switch to one in your wallet.`);
  const signer = lower(await recoverMessageAddress({ message, signature: sig }));
  if (signer !== address) throw new WalletError("WRONG_SIGNER", `${wallet.name} signed with ${signer}, not ${address}. Switch back to that account, or sign out and in again.`);
  return sig;
}

function injectedConnection(w: Announced, address: Hex): EvmConnection {
  const { provider, info } = w;
  return {
    wallet: info,
    address,
    async sign(message) {
      let sig: unknown;
      try {
        sig = await provider.request({ method: "personal_sign", params: [stringToHex(message), address] });
      } catch (e) {
        throw walletError(e, info);
      }
      return checked(message, sig, address, info);
    },
    onAccountChange(fn) {
      const h = (accounts: unknown) => fn(firstAccount(accounts));
      provider.on?.("accountsChanged", h as never);
      // personal_sign doesn't depend on the chain, so a network switch changes nothing here.
      return () => provider.removeListener?.("accountsChanged", h as never);
    },
    async disconnect() {
      // MetaMask and Rabby forget the site; others ignore this.
      await provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
    },
  };
}

// ---- WalletConnect (phones)

const WC_CHAIN = "eip155:1"; // any EVM chain works for personal_sign; mainnet is the one every wallet supports
let wcPromise: Promise<UniversalProvider> | null = null;

function walletConnect(): Promise<UniversalProvider> {
  if (!WC_PROJECT_ID) return Promise.reject(new WalletError("NO_PROJECT", "WalletConnect isn't set up on this deployment (no project id)."));
  if (!wcPromise) {
    const p = import("@walletconnect/universal-provider").then(({ default: UP }) =>
      UP.init({
        projectId: WC_PROJECT_ID,
        metadata: { name: "Behest", description: "Inheritance plans on NEAR", url: window.location.origin, icons: [`${window.location.origin}/icon.svg`] },
      }),
    );
    p.catch(() => {
      if (wcPromise === p) wcPromise = null;
    });
    wcPromise = p;
  }
  return wcPromise;
}

function wcAddress(up: UniversalProvider): Hex | null {
  const acc = up.session?.namespaces?.eip155?.accounts?.[0];
  const a = acc?.split(":")[2];
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? lower(a) : null;
}

function wcConnection(up: UniversalProvider, address: Hex): EvmConnection {
  const peer = up.session?.peer?.metadata;
  const info: WalletInfo = { ...WALLETCONNECT, name: peer?.name || WALLETCONNECT.name, icon: safeIcon(peer?.icons?.[0]) };
  return {
    wallet: info,
    address,
    async sign(message) {
      let sig: unknown;
      try {
        sig = await up.request({ method: "personal_sign", params: [stringToHex(message), address] }, WC_CHAIN);
      } catch (e) {
        throw walletError(e, info);
      }
      return checked(message, sig, address, info);
    },
    onAccountChange(fn) {
      const changed = (accounts: unknown) => fn(firstAccount((accounts as string[] | undefined)?.map((a) => a.split(":").pop())));
      const gone = () => fn(null);
      up.on("accountsChanged", changed);
      up.on("session_delete", gone);
      return () => {
        up.removeListener("accountsChanged", changed);
        up.removeListener("session_delete", gone);
      };
    },
    async disconnect() {
      await up.disconnect().catch(() => {});
    },
  };
}

// ---- connect / restore

// One request at a time: MetaMask declines a second eth_requestAccounts while
// the first is open ("a previous request is still active").
let inFlight: { id: string; p: Promise<EvmConnection> } | null = null;
let wcAbort: (() => void) | null = null;

export function connectingTo(): string | null {
  return inFlight?.id ?? null;
}

/** Asks the wallet for an account (a wallet prompt). WalletConnect reports its pairing link through `onUri`. */
export function connect(id: string, opts: { onUri?: (uri: string) => void } = {}): Promise<EvmConnection> {
  if (inFlight) {
    if (inFlight.id === id) return inFlight.p;
    return Promise.reject(new WalletError("BUSY", "Finish or cancel the wallet request that's already open first."));
  }
  const p = (id === WALLETCONNECT.id ? connectWc(opts.onUri) : connectInjected(id)).finally(() => {
    if (inFlight?.p === p) inFlight = null;
  });
  inFlight = { id, p };
  return p;
}

async function connectInjected(id: string): Promise<EvmConnection> {
  const w = await findInjected(id, 300);
  if (!w) throw new WalletError("NOT_FOUND", "That wallet isn't available in this browser any more. Reload the page and try again.");
  let accounts: unknown;
  try {
    accounts = await w.provider.request({ method: "eth_requestAccounts" });
  } catch (e) {
    throw walletError(e, w.info);
  }
  const a = firstAccount(accounts);
  if (!a) throw new WalletError("NO_ACCOUNT", `${w.info.name} didn't share an account.`);
  return injectedConnection(w, a);
}

async function connectWc(onUri?: (uri: string) => void): Promise<EvmConnection> {
  const up = await walletConnect();
  if (up.session) {
    const a = wcAddress(up);
    if (a) return wcConnection(up, a);
    await up.disconnect().catch(() => {});
  }
  const show = (uri: string) => onUri?.(uri);
  up.on("display_uri", show);
  // Closing the QR code ends the attempt at once (the pairing itself may not reject).
  const cancelled = new Promise<never>((_, reject) => {
    wcAbort = () => {
      reject(new WalletError("REJECTED", "Cancelled."));
      try {
        up.abortPairingAttempt();
      } catch {}
    };
  });
  try {
    await Promise.race([up.connect({ optionalNamespaces: { eip155: { chains: [WC_CHAIN], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"] } } }), cancelled]);
  } catch (e) {
    throw e instanceof WalletError ? e : walletError(e, WALLETCONNECT);
  } finally {
    up.removeListener("display_uri", show);
    wcAbort = null;
  }
  const a = wcAddress(up);
  if (!a) throw new WalletError("NO_ACCOUNT", "The wallet didn't share an Ethereum account.");
  return wcConnection(up, a);
}

/** Stops a WalletConnect pairing that's showing a QR code. */
export function cancelConnect() {
  wcAbort?.();
}

/**
 * Reconnects a remembered wallet without prompting: `eth_accounts` for
 * extensions, the stored session for WalletConnect. Null if it's gone.
 */
export async function restore(saved: { wallet: string; address: string }): Promise<EvmConnection | null> {
  const address = lower(saved.address);
  if (saved.wallet === WALLETCONNECT.id) {
    const up = await walletConnect().catch(() => null);
    return up && wcAddress(up) === address ? wcConnection(up, address) : null;
  }
  const w = await findInjected(saved.wallet);
  if (!w) return null;
  const accounts = await w.provider.request({ method: "eth_accounts" }).catch(() => []);
  return Array.isArray(accounts) && accounts.some((x) => typeof x === "string" && lower(x) === address) ? injectedConnection(w, address) : null;
}
