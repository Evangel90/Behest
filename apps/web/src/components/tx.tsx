"use client";
// Contract calls from the UI: one at a time, with a pending toast that turns
// into the result (and a link to the transaction), and an optional refresh.
import { useCallback, useRef, useState } from "react";
import { NEAR_EXPLORER } from "@/lib/config";
import { humanError } from "@/lib/hooks";
import { useSession, type CallOptions } from "@/lib/session";
import { useToast } from "./feedback";

export interface TxOptions extends CallOptions {
  /** Toast title on success (default "<label>: done"). */
  done?: string;
}

export type Act = (label: string, method: string, args: Record<string, unknown>, opts?: TxOptions) => Promise<boolean>;

export function useTx(after?: () => unknown) {
  const { session } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const afterRef = useRef(after);
  afterRef.current = after;

  const run = useCallback(
    async (label: string, fn: () => Promise<{ txHash: string; sponsored?: boolean; proposalId?: number } | void>, opts: { done?: string } = {}): Promise<boolean> => {
      setBusy(label);
      const id = toast.show({ tone: "pending", title: `${label}…`, body: "Confirm in your wallet if it asks. This usually takes a few seconds." });
      try {
        const r = await fn();
        await Promise.resolve(afterRef.current?.()).catch(() => {});
        if (r && session?.dao) {
          // D26: nothing ran yet; the DAO's council votes on it.
          toast.update(id, {
            tone: "ok",
            title: `Proposed to ${session.dao.id}${r.proposalId !== undefined ? ` as #${r.proposalId}` : ""}`,
            body: "It runs as the DAO once the council approves. Vote below or in your DAO app.",
            href: r.txHash ? `${NEAR_EXPLORER}/txns/${r.txHash}` : undefined,
          });
          return true;
        }
        toast.update(id, {
          tone: "ok",
          title: opts.done ?? `${label}: done.`,
          body: r && r.sponsored ? "Gas paid by Behest." : undefined,
          href: r && r.txHash ? `${NEAR_EXPLORER}/txns/${r.txHash}` : undefined,
        });
        return true;
      } catch (e) {
        toast.update(id, { tone: "error", title: `${label} didn't go through`, body: humanError(e) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast, session],
  );

  const act = useCallback<Act>(
    (label, method, args, opts = {}) => {
      const { done, ...call } = opts;
      return run(
        label,
        async () => {
          if (!session) throw new Error("Sign in first.");
          return session.call(method, args, call);
        },
        { done },
      );
    },
    [run, session],
  );

  return { busy, run, act };
}
