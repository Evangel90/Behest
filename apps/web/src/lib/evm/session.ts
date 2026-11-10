"use client";
// A Session for an Ethereum wallet (D23). The user acts as the NEAR account
// named by their address (0x…, lowercase). Every call is a signed action:
// the wallet signs readable text with personal_sign, Behest's relayer
// submits it as `evm_call`, and the contract checks the signature and the
// nonce. Gas is always Behest's; storage is covered by the sponsor pool (D24).
import { CONTRACT_ID, RELAYER_URL } from "../config";
import { getEvmNonce, isMissingMethod } from "../contract";
import { contractError, type CallOptions, type CallResult, type Session } from "../session";
import { DEADLINE_MS, STORAGE_METHODS, describeAction, signedActionMessage } from "./action";
import type { EvmConnection } from "./wallets";

/** Something an Ethereum wallet can't do here (attach NEAR, call another contract). */
export class EvmUnsupportedError extends Error {
  code = "EVM_UNSUPPORTED";
}

export const NO_NEAR_DEPOSIT = "An Ethereum wallet can't attach NEAR. Fund the plan's Ethereum or Bitcoin vault by sending to its address, or ask someone with a NEAR wallet to add NEAR for you.";

// Nonces are sequential per address, like an account nonce: one signed action
// in flight at a time, and remember the last one used while the RPC catches up.
const queues = new Map<string, Promise<unknown>>();
const lastUsed = new Map<string, bigint>();

const RELAY_CODES: Record<string, string> = {
  NO_ROLE: "E_EVM_NO_ROLE",
  RATE_LIMITED: "E_EVM_RATE_LIMITED",
  BAD_ARGS: "E_EVM_ARGS",
};

async function nextNonce(actor: string): Promise<bigint> {
  let n: bigint;
  try {
    n = await getEvmNonce(actor);
  } catch (e) {
    if (isMissingMethod(e)) throw new Error("Behest's contract doesn't accept Ethereum-wallet signatures yet (it hasn't been upgraded on this network). Sign in with a NEAR wallet for now.");
    throw e;
  }
  const after = lastUsed.get(actor);
  return after != null && after + 1n > n ? after + 1n : n;
}

interface RelayBody {
  tx_hash?: string;
  status?: "ok" | "failed";
  failure?: unknown;
  result?: unknown;
  code?: string;
  error?: string;
}

async function postEvmCall(message: string, signature: string): Promise<RelayBody> {
  let res: Response;
  try {
    res = await fetch(`${RELAYER_URL.replace(/\/$/, "")}/evm-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
  } catch {
    throw new Error("Behest's gas relayer isn't reachable right now. Nothing was sent; try again in a moment.");
  }
  const body = (await res.json().catch(() => ({}))) as RelayBody;
  if (res.status === 404) throw new Error("Behest's gas relayer doesn't take Ethereum-wallet signatures yet. Nothing was sent.");
  if (!res.ok || !body.tx_hash) {
    // The relayer checks the same rules before submitting and answers with its
    // own codes (EVM_NONCE, NO_ROLE…); map them onto the contract's E_ codes
    // so humanError() words them the same way.
    const relayCode = body.code?.startsWith("EVM_") ? `E_${body.code}` : body.code ? RELAY_CODES[body.code] : undefined;
    if (relayCode) throw new Error(relayCode);
    const coded = contractError(body.error) ?? null;
    throw new Error(coded ?? `Relayer: ${body.error ?? `HTTP ${res.status}`}`);
  }
  return body;
}

export function evmSession(conn: EvmConnection): Session {
  const actor = conn.address;
  return {
    accountId: actor,
    kind: "evm",
    label: actor,
    via: conn.wallet.name,
    canSponsorStorage: true,
    personalSign: (message) => conn.sign(message),
    call(method: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallResult> {
      if (opts.receiverId) return Promise.reject(new EvmUnsupportedError("This needs a NEAR wallet: an Ethereum wallet can only act on Behest itself."));
      const deposit = opts.deposit ?? 0n;
      // Storage deposits are dropped: the sponsor pool pays them (D24).
      if (deposit > 0n && !STORAGE_METHODS.has(method)) return Promise.reject(new EvmUnsupportedError(method === "deposit" ? NO_NEAR_DEPOSIT : "This needs NEAR attached, which an Ethereum wallet can't do."));
      const run = async (): Promise<CallResult> => {
        const nonce = await nextNonce(actor);
        const message = signedActionMessage({
          contract: CONTRACT_ID,
          actor,
          method,
          args,
          nonce,
          deadlineMs: Date.now() + DEADLINE_MS,
          summary: opts.summary ?? describeAction(method, args, actor),
        });
        const signature = await conn.sign(message);
        const body = await postEvmCall(message, signature);
        // A failed call reverts the nonce bump with everything else; only a success uses it up.
        if (body.status === "failed") throw new Error(contractError(body.failure) ?? "The transaction failed on chain.");
        lastUsed.set(actor, nonce);
        return { txHash: body.tx_hash!, sponsored: true };
      };
      const prev = queues.get(actor) ?? Promise.resolve();
      const p = prev.catch(() => {}).then(run);
      queues.set(actor, p);
      return p;
    },
  };
}
