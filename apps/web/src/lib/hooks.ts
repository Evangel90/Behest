"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getConfig, getPlan } from "./contract";
import type { PlanView } from "./types";

/** Polls a plan; `chainNow` advances locally between polls from the chain's clock. */
export function usePlan(owner: string | null, intervalMs = 4000) {
  const [view, setView] = useState<PlanView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [chainNow, setChainNow] = useState(0);
  const offset = useRef(0);

  // Loads the token allowlist so ERC-20 amounts format with symbol and decimals.
  useEffect(() => void getConfig().catch(() => {}), []);

  const failures = useRef(0);
  const refresh = useCallback(async () => {
    if (!owner) return;
    try {
      const v = await getPlan(owner);
      if (v) offset.current = v.now_ms - Date.now();
      setView(v);
      setError(null);
      failures.current = 0;
    } catch (e) {
      failures.current++;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [owner]);

  // Poll while the tab is visible; back off while the RPC is failing (public
  // RPCs rate-limit per IP, and hammering them only makes it last longer).
  // Coming back to the tab refreshes at once.
  useEffect(() => {
    if (!owner) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      const delay = Math.min(30_000, intervalMs * 2 ** Math.min(failures.current, 3));
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, delay);
    };
    const onVisible = () => {
      if (document.hidden) return clearTimeout(timer);
      void refresh().then(schedule);
    };
    void refresh().then(schedule);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [owner, refresh, intervalMs]);

  useEffect(() => {
    const t = setInterval(() => setChainNow(Date.now() + offset.current), 1000);
    return () => clearInterval(t);
  }, []);

  return { view, error, refresh, chainNow: chainNow || (view?.now_ms ?? 0) };
}

/** Runs one contract action at a time and keeps its outcome for display. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; txHash?: string } | null>(null);
  const run = useCallback(async (label: string, fn: () => Promise<{ txHash: string; sponsored?: boolean; proposalId?: number } | void>, done?: string) => {
    setBusy(label);
    setResult(null);
    try {
      const r = await fn();
      const proposed = r && r.proposalId !== undefined ? `${label}: proposed to the DAO as #${r.proposalId}. It runs once the council approves.` : null;
      setResult({ ok: true, text: proposed ?? done ?? `${label}: done${r && r.sponsored ? " · gas paid by Behest" : ""}.`, txHash: r ? r.txHash : undefined });
    } catch (e) {
      setResult({ ok: false, text: humanError(e) });
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, result, run, clear: () => setResult(null) };
}

const ERRORS: Record<string, string> = {
  E_NOT_OVERDUE: "The owner isn't overdue yet, so a release can't be proposed.",
  E_PROPOSAL_EXISTS: "A release is already open for this plan.",
  E_ALREADY_VOTED: "You've already voted on this proposal.",
  E_NOT_GUARDIAN: "This account isn't a guardian of the plan.",
  E_NOT_HEIR: "This account isn't an heir of the plan.",
  E_NOT_ELIGIBLE: "It isn't time yet: the waiting period hasn't ended.",
  E_INSUFFICIENT_FEE_RESERVE: "The Ethereum vault doesn't hold enough to cover network fees.",
  E_PROPOSAL_OPEN: "The plan can't change while a release is open.",
  E_INSUFFICIENT_DEPOSIT: "Attach a little more NEAR to cover storage.",
  E_PAUSED: "Behest is paused by the operator.",
  E_CANCEL_WINDOW_CLOSED: "The waiting period is over, so the release can no longer be cancelled.",
  E_NOT_PROPOSED: "There's no proposal waiting for votes.",
  E_NO_PLAN: "There's no plan for this account.",
  E_NOTHING_TO_DISTRIBUTE: "There's nothing in the plan to distribute yet.",
  E_INSUFFICIENT_ESCROW: "Not enough NEAR in the plan for that.",
  E_DURATION_OUT_OF_BOUNDS: "One of the timers is outside the allowed range.",
  E_CONFLICTING_ROLE: "Someone can't be both an heir and a guardian, or guard their own plan.",
  E_UNAUTHORIZED: "This account isn't allowed to do that.",
  E_BTC_VAULT_UNKNOWN: "Set up the plan's Bitcoin vault first.",
  E_INVALID_BTC_ADDRESS: "That isn't a testnet SegWit Bitcoin address (tb1q… or tb1p…).",
  E_INVALID_UTXOS: "The Bitcoin coins reported don't match the vault. Refresh and try again.",
  E_BTC_NOT_HEAD: "Only the latest Bitcoin payout can be re-sent with a higher fee; this one confirms once the network catches up.",
  E_FEE_AT_CAP: "The network fee is already at the cap.",
  // D23/D24: Ethereum-wallet signed actions and sponsored storage
  E_NOT_DELEGATE: "This account isn't one of the plan's check-in delegates.",
  E_INVALID_DELEGATES: "Check-in delegates: at most 10, no repeats, and not the owner.",
  // D28/D29
  E_NO_PENDING_CHANGE: "There's no waiting change to apply or cancel. It may already have been applied.",
  E_CHANGE_NOT_DUE: "That change's notice period hasn't ended yet.",
  E_INVALID_GUARDIAN_SETTINGS: "Standby guardians: at most 5, no repeats, and not the owner, a heir, a guardian, an alternate or the fallback.",
  E_GUARDIAN_AVAILABLE: "That guardian has confirmed recently, so a standby can't take the seat.",
  E_NO_STANDBY: "No standby guardian is free and available to take the seat.",
  E_GUARDIAN_RESIGNED: "This guardian has resigned and can no longer vote or confirm.",
  E_GUARDIAN_CHANGE_PENDING: "A seat change for that guardian (or to that account) is already waiting.",
  E_NO_GUARDIAN_CHANGE: "There's no waiting seat change for that guardian.",
  E_INVALID_DESTINATION: "That address isn't one registered (or requested) for this heir on that network, or isn't a valid address.",
  E_NOT_RECIPIENT: "Only the plan's heirs, alternates and fallback can ask for a new address.",
  E_NO_DESTINATION_REQUEST: "There's no open request for that heir and network.",
  E_OWNER_NOT_ACTIVE: "New addresses can only be requested while the owner is active.",
  E_DESTINATION_PROOF: "The proof didn't match: sign the exact message, with the key of that address.",
  E_INVALID_SEALED_HEIRS: "The private heir settings aren't valid (1 to 10 heirs, distinct fingerprints, a reveal window within the allowed range).",
  E_NOT_SEALED: "This plan doesn't keep its heirs private.",
  E_UNKNOWN_COMMITMENT: "That record doesn't match this plan. It may be from an older version of the plan.",
  E_ALREADY_REVEALED: "That heir is already revealed.",
  E_REVEAL_NOT_OPEN: "Heirs can only be revealed once the owner is overdue, before a release is proposed.",
  E_REVEALS_PENDING: "Some private heirs haven't revealed yet. A release can start once all are revealed, or after the reveal window.",
  E_DESTINATION_PROOF_UNSUPPORTED: "Taproot (tb1p…) addresses can't be proven yet. Use a tb1q address.",
  ERR_MIN_BOND: "The DAO's proposal bond changed. Reload and try again.",
  ERR_PERMISSION_DENIED: "Your role in the DAO doesn't allow that.",
  E_INVALID_TIERS: "That tier schedule isn't valid (the first tier must be free, prices must rise, and the last tier must allow everything).",
  E_INSUFFICIENT_TREASURY: "The treasury doesn't hold that much.",
  E_SPONSOR_EXHAUSTED: "Behest can't cover storage for this right now (its sponsor pool or your allowance is used up). Nothing changed.",
  E_EVM_METHOD: "That can't be done from an email or Ethereum-wallet sign-in. Nothing changed.",
  E_EVM_NONCE: "Another signed action went through first. Try again: you'll be asked to sign once more.",
  E_EVM_EXPIRED: "The signature expired before it reached the chain. Try again.",
  E_EVM_NO_ROLE: "Your account doesn't have a role in this plan that allows that. Nothing changed.",
  E_EVM_RATE_LIMITED: "Too many signed actions in a short time. Wait a minute and try again.",
  E_EVM_SIGNATURE: "That signature couldn't be checked. Try again, and make sure your wallet signs with the connected account.",
  E_EVM_ACTOR: "The signature came from a different account than the one signed in. Switch back in your wallet and try again.",
};

export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = msg.match(/E_[A-Z_]+/)?.[0];
  if (code === "E_TIER_REQUIRED") {
    const tier = msg.match(/needs the ([A-Za-z0-9 ]+?) tier/)?.[1];
    return `This change needs the ${tier ?? "next"} tier. Upgrade from the plan screen (paid once, in USDC), then save again. Nothing changed.`;
  }
  if (code && ERRORS[code]) return ERRORS[code];
  const sputnik = msg.match(/ERR_[A-Z_]+/)?.[0];
  if (sputnik && ERRORS[sputnik]) return ERRORS[sputnik];
  if (code?.startsWith("E_EVM_")) return `Behest couldn't accept that signature (${code}). Nothing changed.`;
  if (/rejected|cancel|denied/i.test(msg)) return "You cancelled in your wallet. Nothing was sent.";
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}
