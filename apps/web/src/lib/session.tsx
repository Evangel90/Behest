"use client";
// One signing interface over three kinds of sign-in:
//  - "persona": a generated testnet account whose key lives in this browser ("Try as…")
//  - "wallet": any NEAR Connect wallet (HOT, Meteor, Intear, MyNearWallet, Ledger, …)
//  - "evm": an Ethereum wallet (MetaMask, Rabby, Coinbase Wallet, WalletConnect)
//    connected in the app. The user acts as the NEAR account named by their
//    address (0x…); every action is a signed message the relayer submits (D23).
//  - "dao": a council member (signed in with a NEAR wallet or a persona) acts
//    as a SputnikDAO. Every call becomes an add_proposal on the DAO with the
//    bond attached; it runs as the DAO once the council approves (D26).
// Calls that the relayer sponsors (heirs, guardians, owner check-in/cancel) go
// as NEP-366 meta-transactions whenever the signer can produce one, so those
// people need no NEAR. Everything else is a normal transaction.
import { SPONSORED_METHODS } from "@behest/relayer/methods";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { Account, KeyPair, actions, base64Encode, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CONTRACT_ID, RELAYER_URL } from "./config";
import { sharedConnector } from "./connector";
import { provider } from "./contract";
import { loadSandbox, type Persona } from "./demo";
import type { EvmConnection } from "./evm/wallets";
import { getPolicy, proposalArgs, type DaoCall, type DaoPolicy } from "./dao";

export interface CallOptions {
  deposit?: bigint;
  tgas?: number;
  /** Another contract to call (e.g. a token's ft_transfer_call). Never sponsored. */
  receiverId?: string;
  /**
   * D24: send through the relayer with no deposit, so Behest's sponsor pool
   * pays the storage. Fails with SponsorRefused if the relayer or the pool
   * says no; the caller can then pay itself.
   */
  sponsor?: boolean;
  /** Ethereum wallets: the plain-words line shown above what they sign. */
  summary?: string;
}
export interface CallResult {
  txHash: string;
  sponsored: boolean;
  /** D26: the call was proposed to the DAO, not run; it runs once the council approves. */
  proposalId?: number;
}

export interface Session {
  accountId: string;
  kind: "persona" | "wallet" | "evm" | "dao";
  label: string;
  /** Short name of the wallet, or the persona's role. */
  via: string;
  /** Can send owner changes through the relayer so Behest pays their storage (D24). */
  canSponsorStorage: boolean;
  /** Ethereum wallets: EIP-191 personal_sign of UTF-8 text. */
  personalSign?(message: string): Promise<string>;
  call(method: string, args: Record<string, unknown>, opts?: CallOptions): Promise<CallResult>;
  /** D26: the DAO this session acts for, and the member who signs its proposals. */
  dao?: { id: string; member: Session; policy: DaoPolicy };
  /** D26: several calls to one contract in one proposal (one vote runs them together). */
  propose?(calls: DaoCall[], description?: string): Promise<CallResult>;
}

interface Ctx {
  session: Session | null;
  ready: boolean;
  connectWallet(): Promise<void>;
  /** Connects an Ethereum wallet by id (EIP-6963 rdns or "walletconnect"). WalletConnect reports its pairing link through onUri. */
  connectEvm(walletId: string, opts?: { onUri?: (uri: string) => void }): Promise<void>;
  actAsPersona(p: Persona): void;
  /** D26: act as a DAO the signed-in NEAR account can propose to. */
  actAsDao(dao: string): Promise<void>;
  /** Back to the member's own account. */
  leaveDao(): void;
  signOut(): Promise<void>;
}

const SessionContext = createContext<Ctx | null>(null);
export const useSession = () => {
  const c = useContext(SessionContext);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
};

const sponsorable = (method: string, deposit: bigint) => deposit === 0n && method in SPONSORED_METHODS;

async function relay(signedDelegateBase64: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${RELAYER_URL.replace(/\/$/, "")}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed_delegate: signedDelegateBase64 }),
    });
  } catch {
    throw new RelayError("UNREACHABLE", "the gas relayer is not reachable");
  }
  const body = (await res.json().catch(() => ({}))) as { tx_hash?: string; status?: string; code?: string; error?: string; failure?: unknown };
  if (!res.ok || !body.tx_hash) throw new RelayError(body.code ?? `HTTP_${res.status}`, body.error ?? "relayer unavailable");
  if (body.status === "failed") {
    const code = contractError(body.failure);
    if (code && /^E_(SPONSOR_EXHAUSTED|INSUFFICIENT_DEPOSIT)/.test(code)) throw new SponsorRefused(code);
    throw new Error(code ?? "The transaction failed on chain.");
  }
  return body.tx_hash;
}

class RelayError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Behest couldn't cover this change's storage (relayer refused or down, or the pool is used up). Nothing changed. */
export class SponsorRefused extends Error {
  constructor(reason: string) {
    super(`Behest couldn't cover the storage this time (${reason}).`);
  }
}

/** Pulls the contract's coded error (E_…) out of an execution failure. */
export function contractError(e: unknown): string | null {
  const m = JSON.stringify(e ?? "").match(/E_[A-Z_]+[^"\\]*/);
  return m ? m[0] : null;
}

function txHashOf(outcome: unknown): string {
  const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
  return o?.transaction?.hash ?? o?.transaction_outcome?.id ?? "";
}

function failureOf(outcome: unknown): string | null {
  const s = JSON.stringify((outcome as { status?: unknown })?.status ?? {});
  return s.includes("Failure") ? (contractError(s) ?? "The transaction failed on chain.") : null;
}

/** A relayer failure on a `sponsor` call becomes SponsorRefused, so the caller can pay instead. */
const refused = (e: unknown) => (e instanceof RelayError ? new SponsorRefused(e.message) : e);

export function personaSession(p: Persona): Session {
  const acct = new Account(p.accountId, provider, p.secretKey as KeyPairString);
  return {
    accountId: p.accountId,
    kind: "persona",
    label: p.label,
    via: "Test persona",
    canSponsorStorage: true,
    async call(method, args, opts = {}) {
      const deposit = opts.sponsor ? 0n : (opts.deposit ?? 0n);
      const fc = actions.functionCall(method, args, teraToGas(opts.tgas ?? 100), deposit);
      const receiverId = opts.receiverId ?? CONTRACT_ID;
      if (!opts.receiverId && (opts.sponsor || sponsorable(method, deposit))) {
        try {
          const { signedDelegate } = await acct.createSignedMetaTransaction({ receiverId: CONTRACT_ID, actions: [fc], blockHeightTtl: 120 });
          return { txHash: await relay(base64Encode(encodeSignedDelegate(signedDelegate))), sponsored: true };
        } catch (e) {
          if (opts.sponsor) throw refused(e);
          // Relayer down, or up but unable to reach the chain: the persona holds
          // a little NEAR, so pay gas directly. Policy refusals (4xx) still fail.
          // If the relayed call did land after all, the repeat is rejected or
          // harmless: every sponsored method is guarded against running twice.
          const infra = e instanceof RelayError && (e.code === "UNREACHABLE" || e.code === "RELAY_FAILED" || /^HTTP_5/.test(e.code));
          if (!infra) throw e instanceof RelayError ? new Error(`Relayer: ${e.message}`) : e;
        }
      }
      const out = await acct.signAndSendTransaction({ receiverId, actions: [fc], throwOnFailure: false });
      const err = failureOf(out);
      if (err) throw new Error(err);
      return { txHash: txHashOf(out), sponsored: false };
    },
  };
}

function walletSession(wallet: NearWalletBase, accountId: string): Session {
  const canDelegate = Boolean(wallet.manifest.features?.signDelegateActions);
  return {
    accountId,
    kind: "wallet",
    label: accountId,
    via: wallet.manifest.name,
    canSponsorStorage: canDelegate,
    async call(method, args, opts = {}) {
      if (opts.sponsor && (!canDelegate || opts.receiverId)) throw new SponsorRefused(`${wallet.manifest.name} can't sign meta-transactions`);
      const deposit = opts.sponsor ? 0n : (opts.deposit ?? 0n);
      const fc = actions.functionCall(method, args, teraToGas(opts.tgas ?? 100), deposit);
      const receiverId = opts.receiverId ?? CONTRACT_ID;
      if (canDelegate && !opts.receiverId && (opts.sponsor || sponsorable(method, deposit))) {
        const { signedDelegateActions } = await wallet.signDelegateActions({
          network: "testnet",
          signerId: accountId,
          delegateActions: [{ receiverId: CONTRACT_ID, actions: [fc] }],
        });
        const signed = signedDelegateActions[0];
        if (signed) {
          try {
            return { txHash: await relay(signed), sponsored: true };
          } catch (e) {
            if (opts.sponsor) throw refused(e);
            if (!(e instanceof RelayError) || e.code !== "UNREACHABLE") throw e instanceof RelayError ? new Error(`Relayer: ${e.message}`) : e;
          }
        } else if (opts.sponsor) throw new SponsorRefused(`${wallet.manifest.name} didn't sign`);
      }
      const out = await wallet.signAndSendTransaction({ network: "testnet", signerId: accountId, receiverId, actions: [fc] });
      const err = failureOf(out);
      if (err) throw new Error(err);
      return { txHash: txHashOf(out), sponsored: false };
    },
  };
}

/**
 * D26: `member` proposes; the DAO acts. Deposits ride inside the proposal (the
 * DAO pays them from its own balance when it runs); the member attaches only
 * the bond, which Sputnik returns when the proposal passes or is rejected.
 * Nothing is sponsored: the council member who casts the deciding vote signs
 * the transaction that runs the call, so the relayer never sees it.
 */
export function daoSession(member: Session, dao: string, policy: DaoPolicy): Session {
  const propose = async (calls: DaoCall[], description?: string): Promise<CallResult> => {
    let feeToken: string | null = null;
    try {
      feeToken = (await (await import("./tiers")).getTierConfig()).fee_token;
    } catch {}
    const r = await member.call("add_proposal", proposalArgs(dao, calls, description, feeToken), { receiverId: dao, deposit: BigInt(policy.proposal_bond), tgas: 50 });
    // add_proposal returns the new id; reading the counter right after is good enough (ids only grow).
    let proposalId: number | undefined;
    try {
      proposalId = (await (await import("./contract")).view<number>("get_last_proposal_id", {}, dao)) - 1;
    } catch {}
    return { txHash: r.txHash, sponsored: false, proposalId };
  };
  return {
    accountId: dao,
    kind: "dao",
    label: dao,
    via: `DAO · ${member.label}`,
    canSponsorStorage: false,
    dao: { id: dao, member, policy },
    propose,
    async call(method, args, opts = {}) {
      if (opts.sponsor) throw new SponsorRefused("a DAO's calls are signed by the member who casts the last vote, so they attach their own storage deposit");
      return propose([{ method, args, deposit: opts.deposit, tgas: opts.tgas, receiverId: opts.receiverId }], opts.summary);
    },
  };
}

const PERSONA_KEY = "behest.persona";
/** D26: the DAO the signed-in member acts as, re-entered on reload. */
const DAO_KEY = "behest.dao";
/** The Ethereum wallet last connected: { wallet: id, address }. Reconnected silently on load. */
const EVM_KEY = "behest.evm";
const evm = () => import("./evm/wallets");
const evmSessionOf = async (c: EvmConnection) => (await import("./evm/session")).evmSession(c);

function savedEvm(): { wallet: string; address: string } | null {
  try {
    const raw = localStorage.getItem(EVM_KEY);
    const v = raw ? (JSON.parse(raw) as { wallet?: unknown; address?: unknown }) : null;
    return v && typeof v.wallet === "string" && typeof v.address === "string" ? { wallet: v.wallet, address: v.address } : null;
  } catch {
    return null;
  }
}
const forget = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {}
};

export function SessionProvider({ children }: { children: ReactNode }) {
  // `base` is the signed-in account; `dao` (D26) wraps it while acting for a DAO.
  const [session, setBase] = useState<Session | null>(null);
  const [dao, setDao] = useState<Session | null>(null);
  const setSession = useCallback((s: Session | null | ((prev: Session | null) => Session | null)) => {
    setBase(s);
    setDao(null);
  }, []);
  const [ready, setReady] = useState(false);
  const connector = useRef<NearConnector | null>(null);
  const evmConn = useRef<EvmConnection | null>(null);
  const unwatch = useRef<(() => void) | null>(null);

  /** Forgets the Ethereum wallet; `revoke` also asks the wallet to drop the site. */
  const dropEvm = useCallback((revoke: boolean) => {
    unwatch.current?.();
    unwatch.current = null;
    const c = evmConn.current;
    evmConn.current = null;
    forget(EVM_KEY);
    if (revoke && c) void c.disconnect();
  }, []);

  const getConnector = useCallback(async () => {
    const c = await sharedConnector();
    if (connector.current !== c) {
      connector.current = c;
      c.on("wallet:signIn", async ({ wallet, accounts }) => {
        const id = accounts[0]?.accountId;
        if (id) {
          forget(PERSONA_KEY);
          dropEvm(false);
          setSession(walletSession(wallet, id));
        }
      });
      c.on("wallet:signOut", () => setSession((s) => (s?.kind === "wallet" ? null : s)));
    }
    return c;
  }, [dropEvm]);

  const adoptEvm = useCallback(
    async (c: EvmConnection) => {
      unwatch.current?.();
      evmConn.current = c;
      try {
        localStorage.setItem(EVM_KEY, JSON.stringify({ wallet: c.wallet.id, address: c.address }));
      } catch {}
      // Switching accounts in the wallet switches the session (eth_accounts, no prompt); disconnecting signs out.
      unwatch.current = c.onAccountChange(async (address) => {
        if (evmConn.current !== c) return;
        const next = address ? await (await evm()).restore({ wallet: c.wallet.id, address }).catch(() => null) : null;
        if (evmConn.current !== c) return;
        if (next) await adoptEvm(next);
        else {
          dropEvm(false);
          setSession((s) => (s?.kind === "evm" ? null : s));
        }
      });
      setSession(await evmSessionOf(c));
    },
    [dropEvm],
  );

  useEffect(() => {
    (async () => {
      try {
        const personaId = localStorage.getItem(PERSONA_KEY);
        const persona = personaId ? Object.values(loadSandbox()?.personas ?? {}).find((p) => p.accountId === personaId) : undefined;
        if (persona) {
          setSession(personaSession(persona));
          return;
        }
        const saved = savedEvm();
        if (saved) {
          const c = await (await evm()).restore(saved).catch(() => null);
          if (c) {
            await adoptEvm(c);
            return;
          }
          forget(EVM_KEY);
        }
        const c = await getConnector();
        const { wallet, accounts } = await c.getConnectedWallet().catch(() => ({ wallet: null, accounts: [] as { accountId: string }[] }));
        if (wallet && accounts[0]) setSession(walletSession(wallet, accounts[0].accountId));
      } finally {
        setReady(true);
      }
    })();
  }, [getConnector, adoptEvm]);

  // Re-enter the DAO after a reload, once the member's session is back.
  useEffect(() => {
    if (!session || session.kind === "evm") return;
    let saved: { dao?: string; member?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(DAO_KEY) ?? "null");
    } catch {}
    if (!saved?.dao || saved.member !== session.accountId) return;
    let live = true;
    getPolicy(saved.dao).then(
      (p) => live && setDao(daoSession(session, saved!.dao!, p)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session]);

  const value = useMemo<Ctx>(
    () => ({
      session: dao ?? session,
      ready,
      async actAsDao(id) {
        if (!session || session.kind === "evm") throw new Error("Sign in with a NEAR wallet to act for a DAO.");
        let policy: DaoPolicy;
        try {
          policy = await getPolicy(id);
        } catch {
          throw new Error(`${id} isn't a SputnikDAO (it has no get_policy).`);
        }
        try {
          localStorage.setItem(DAO_KEY, JSON.stringify({ dao: id, member: session.accountId }));
        } catch {}
        setDao(daoSession(session, id, policy));
      },
      leaveDao() {
        forget(DAO_KEY);
        setDao(null);
      },
      async connectWallet() {
        const c = await getConnector();
        await c.connect();
      },
      async connectEvm(walletId, opts) {
        const c = await (await evm()).connect(walletId, opts);
        forget(PERSONA_KEY);
        if (session?.kind === "wallet") await (await getConnector()).disconnect().catch(() => {});
        await adoptEvm(c);
      },
      actAsPersona(p) {
        try {
          localStorage.setItem(PERSONA_KEY, p.accountId);
        } catch {}
        dropEvm(false);
        setSession(personaSession(p));
      },
      async signOut() {
        forget(PERSONA_KEY);
        forget(DAO_KEY);
        if (session?.kind === "wallet") await (await getConnector()).disconnect().catch(() => {});
        if (session?.kind === "evm") dropEvm(true);
        setSession(null);
      },
    }),
    [session, dao, ready, getConnector, adoptEvm, dropEvm],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** New ed25519 key for a persona; only the public half leaves the browser. */
export function newKeyPair() {
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}
