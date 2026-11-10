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
  const run = useCallback(async (label: string, fn: () => Promise<{ txHash: string; sponsored?: boolean } | void>, done?: string) => {
    setBusy(label);
    setResult(null);
    try {
      const r = await fn();
      setResult({ ok: true, text: done ?? `${label}: done${r && r.sponsored ? " · gas paid by Behest" : ""}.`, txHash: r ? r.txHash : undefined });
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
};

export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = msg.match(/E_[A-Z_]+/)?.[0];
  if (code && ERRORS[code]) return ERRORS[code];
  if (/rejected|cancel|denied/i.test(msg)) return "You cancelled in your wallet. Nothing was sent.";
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}
