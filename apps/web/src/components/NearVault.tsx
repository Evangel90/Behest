"use client";
// A plan's NEAR deposit address (NEAR vault): an account only the plan's
// contract can sign for. NEAR sent there from any wallet, exchange or faucet
// is moved into the plan's escrow by an executor within a few minutes. And,
// on testnet, a faucet that adds test NEAR to the plan directly.
import { Droplets, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NEAR_EXPLORER } from "@/lib/config";
import { view } from "@/lib/contract";
import { humanError } from "@/lib/hooks";
import { isTestnet } from "@/lib/tiers";
import { useToast } from "./feedback";
import { Address, CopyButton } from "./interactive";
import { QrCode } from "./QrCode";
import type { Act } from "./tx";
import { Button, Skeleton } from "./ui";

export interface NearVault {
  path: string;
  public_key: string;
  account_id: string;
}

export function useNearVault(owner: string) {
  const [v, setV] = useState<NearVault | null | undefined>(undefined);
  // A failed read (e.g. a rate-limited RPC) isn't "no vault": keep loading and retry.
  const reload = useCallback(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        return setV(await view<NearVault | null>("get_near_vault", { owner }));
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
  }, [owner]);
  useEffect(() => void reload(), [reload]);
  return { vault: v, reload };
}

/** The deposit address, or the button that creates it. */
export function NearDepositAddress({ owner, act, busy, onFunded }: { owner: string; act: Act; busy: boolean; onFunded?: () => unknown }) {
  const { vault, reload } = useNearVault(owner);
  if (vault === undefined) return <Skeleton className="h-40 w-full rounded-tile" />;
  return (
    <div className="flex flex-col gap-3">
      {vault ? (
        <>
          <div className="flex flex-wrap items-start gap-4">
            <QrCode value={vault.account_id} label="QR code of the plan's NEAR deposit address" className="size-32 text-ink" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-sm font-semibold">Send NEAR to</span>
              <code className="break-all rounded-tile bg-subtle p-2.5 font-mono text-xs">{vault.account_id}</code>
              <div className="flex flex-wrap gap-2">
                <CopyButton value={vault.account_id} label="Copy address" />
                <Address value={vault.account_id} href={`${NEAR_EXPLORER}/address/${vault.account_id}`} label="NEAR deposit address" className="text-xs text-muted" />
              </div>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed text-muted">From any NEAR wallet or exchange. It moves into the plan within a few minutes; a little stays behind for the network fee. Only this plan&apos;s contract can sign for this address, and only to put NEAR into your plan.</p>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] leading-relaxed text-muted">Get an address you can send NEAR to from any wallet or exchange, no NEAR wallet needed. Only this plan&apos;s contract can sign for it.</p>
          <Button
            size="sm"
            variant="ink"
            icon={KeyRound}
            className="self-start"
            loading={busy}
            onClick={async () => {
              if (await act("Create a NEAR deposit address", "register_near_vault", { owner }, { done: "Your plan has a NEAR deposit address." })) await reload();
            }}
          >
            Create a deposit address
          </Button>
        </div>
      )}
      {isTestnet && <TestNearFaucet owner={owner} onFunded={onFunded} />}
    </div>
  );
}

function TestNearFaucet({ owner, onFunded }: { owner: string; onFunded?: () => unknown }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
      <Button
        size="sm"
        variant="subtle"
        icon={Droplets}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await fetch("/api/demo/near", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
            const b = (await r.json().catch(() => ({}))) as { amount?: string; error?: string };
            if (!r.ok) throw new Error(b.error ?? "The test faucet couldn't add NEAR.");
            toast.show({ tone: "ok", title: "Test NEAR added", body: `${b.amount} test NEAR is now in the plan.` });
            await onFunded?.();
          } catch (e) {
            toast.show({ tone: "error", title: "No test NEAR this time", body: humanError(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        Add test NEAR
      </Button>
      <span className="text-[13px] text-muted">Testnet only: Behest&apos;s faucet adds 0.2 test NEAR to the plan.</span>
    </div>
  );
}
