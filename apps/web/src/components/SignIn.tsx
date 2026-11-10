"use client";
import Link from "next/link";
import { ArrowRight, FlaskConical, Hexagon, Mail, Wallet, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { Dialog } from "./interactive";
import { Notice, TestnetTag, cx } from "./ui";

const NEAR_AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_NEAR_AUTH_CLIENT_ID);

export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connectWallet } = useSession();
  const [error, setError] = useState<string | null>(null);

  async function wallet() {
    setError(null);
    try {
      onClose();
      await connectWallet();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.");
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Sign in" description="Behest never holds your keys. Pick whatever you already use.">
      <div className="flex flex-col gap-2">
        <Option icon={Wallet} onClick={wallet} title="NEAR wallet" body="HOT, Meteor, Intear, MyNearWallet, Ledger, or any WalletConnect wallet." tag="Gas sponsored" />
        <Option
          icon={Hexagon}
          onClick={wallet}
          title="Ethereum wallet"
          body="MetaMask, Rabby, Coinbase… Choose “Ethereum Wallets” in the next step. You act from a NEAR account at your own 0x address."
          tag="Pays own gas"
        />
        <Option
          icon={Mail}
          disabled={!NEAR_AUTH_ENABLED}
          title="Email, Google or passkey"
          body={NEAR_AUTH_ENABLED ? "No wallet needed." : "Through NEAR Auth. Not switched on yet: it needs a client ID issued by NEAR."}
          tag={NEAR_AUTH_ENABLED ? "No wallet" : "Soon"}
        />
      </div>
      <Link href="/try" onClick={onClose} className="group flex items-start gap-3 rounded-row border border-dashed border-line-strong p-4 transition-colors hover:border-signal hover:bg-card">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-s-approved text-[var(--s-approved-fg)]">
          <FlaskConical className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 font-semibold">
            Try as a test persona
            <TestnetTag />
          </span>
          <span className="text-sm text-muted">An owner, three guardians and two heirs with funded testnet accounts. Switch between them any time.</span>
        </span>
        <ArrowRight aria-hidden className="mt-2 size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
      </Link>
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

function Option({ icon: I, title, body, tag, onClick, disabled }: { icon: LucideIcon; title: string; body: string; tag: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "group flex items-start gap-3 rounded-row border border-line bg-card p-4 text-left transition-[border,background] duration-150",
        "hover:border-signal disabled:cursor-not-allowed disabled:bg-transparent disabled:text-muted disabled:hover:border-line",
      )}
    >
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-subtle">
        <I className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center justify-between gap-2 font-semibold">
          {title}
          <span className="inline-flex h-6 items-center rounded-tag bg-subtle px-2 text-xs font-semibold text-muted">{tag}</span>
        </span>
        <span className="text-sm text-muted">{body}</span>
      </span>
    </button>
  );
}
