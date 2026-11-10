"use client";
// One signing interface over three kinds of sign-in:
//  - "persona": a generated testnet account whose key lives in this browser ("Try as…")
//  - "wallet": any NEAR Connect wallet (HOT, Meteor, Intear, MyNearWallet, Ledger, …)
//  - Ethereum wallets (MetaMask etc.) also come through NEAR Connect as eth-implicit
//    0x… NEAR accounts.
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

export interface CallOptions {
  deposit?: bigint;
  tgas?: number;
  /** Another contract to call (e.g. a token's ft_transfer_call). Never sponsored. */
  receiverId?: string;
}
export interface CallResult {
  txHash: string;
  sponsored: boolean;
}

export interface Session {
  accountId: string;
  kind: "persona" | "wallet";
  label: string;
  /** Short name of the wallet, or the persona's role. */
  via: string;
  call(method: string, args: Record<string, unknown>, opts?: CallOptions): Promise<CallResult>;
}

interface Ctx {
  session: Session | null;
  ready: boolean;
  connectWallet(): Promise<void>;
  actAsPersona(p: Persona): void;
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
  if (body.status === "failed") throw new Error(contractError(body.failure) ?? "The transaction failed on chain.");
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

export function personaSession(p: Persona): Session {
  const acct = new Account(p.accountId, provider, p.secretKey as KeyPairString);
  return {
    accountId: p.accountId,
    kind: "persona",
    label: p.label,
    via: "Test persona",
    async call(method, args, opts = {}) {
      const deposit = opts.deposit ?? 0n;
      const fc = actions.functionCall(method, args, teraToGas(opts.tgas ?? 100), deposit);
      const receiverId = opts.receiverId ?? CONTRACT_ID;
      if (!opts.receiverId && sponsorable(method, deposit)) {
        try {
          const { signedDelegate } = await acct.createSignedMetaTransaction({ receiverId: CONTRACT_ID, actions: [fc], blockHeightTtl: 120 });
          return { txHash: await relay(base64Encode(encodeSignedDelegate(signedDelegate))), sponsored: true };
        } catch (e) {
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
    async call(method, args, opts = {}) {
      const deposit = opts.deposit ?? 0n;
      const fc = actions.functionCall(method, args, teraToGas(opts.tgas ?? 100), deposit);
      const receiverId = opts.receiverId ?? CONTRACT_ID;
      if (canDelegate && !opts.receiverId && sponsorable(method, deposit)) {
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
            if (!(e instanceof RelayError) || e.code !== "UNREACHABLE") throw e instanceof RelayError ? new Error(`Relayer: ${e.message}`) : e;
          }
        }
      }
      const out = await wallet.signAndSendTransaction({ network: "testnet", signerId: accountId, receiverId, actions: [fc] });
      const err = failureOf(out);
      if (err) throw new Error(err);
      return { txHash: txHashOf(out), sponsored: false };
    },
  };
}

const PERSONA_KEY = "behest.persona";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const connector = useRef<NearConnector | null>(null);
  const getConnector = useCallback(async () => {
    const c = await sharedConnector();
    if (connector.current !== c) {
      connector.current = c;
      c.on("wallet:signIn", async ({ wallet, accounts }) => {
        const id = accounts[0]?.accountId;
        if (id) {
          localStorage.removeItem(PERSONA_KEY);
          setSession(walletSession(wallet, id));
        }
      });
      c.on("wallet:signOut", () => setSession((s) => (s?.kind === "wallet" ? null : s)));
    }
    return c;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const personaId = localStorage.getItem(PERSONA_KEY);
        const persona = personaId ? Object.values(loadSandbox()?.personas ?? {}).find((p) => p.accountId === personaId) : undefined;
        if (persona) {
          setSession(personaSession(persona));
          return;
        }
        const c = await getConnector();
        const { wallet, accounts } = await c.getConnectedWallet().catch(() => ({ wallet: null, accounts: [] as { accountId: string }[] }));
        if (wallet && accounts[0]) setSession(walletSession(wallet, accounts[0].accountId));
      } finally {
        setReady(true);
      }
    })();
  }, [getConnector]);

  const value = useMemo<Ctx>(
    () => ({
      session,
      ready,
      async connectWallet() {
        const c = await getConnector();
        await c.connect();
      },
      actAsPersona(p) {
        try {
          localStorage.setItem(PERSONA_KEY, p.accountId);
        } catch {}
        setSession(personaSession(p));
      },
      async signOut() {
        try {
          localStorage.removeItem(PERSONA_KEY);
        } catch {}
        if (session?.kind === "wallet") await (await getConnector()).disconnect().catch(() => {});
        setSession(null);
      },
    }),
    [session, ready, getConnector],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** New ed25519 key for a persona; only the public half leaves the browser. */
export function newKeyPair() {
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}
