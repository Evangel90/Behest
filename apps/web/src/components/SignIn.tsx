"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { Notice } from "./ui";

const NEAR_AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_NEAR_AUTH_CLIENT_ID);

export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { connectWallet } = useSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

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
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="signin-title"
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-card border-[1.5px] border-ink bg-paper p-0 text-ink backdrop:bg-ink/60"
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 id="signin-title" className="font-display text-3xl font-bold tracking-[-0.03em]">
            Sign in
          </h2>
          <button onClick={onClose} className="min-h-11 min-w-11 rounded-full text-2xl leading-none hover:bg-line-soft" aria-label="Close">
            ×
          </button>
        </div>
        <p className="text-sm text-muted">Behest never holds your keys. Pick whatever you already use.</p>

        <Option onClick={wallet} title="NEAR wallet" body="HOT, Meteor, Intear, MyNearWallet, Ledger, or any WalletConnect wallet." tag="Gas sponsored" />
        <Option
          onClick={wallet}
          title="Ethereum wallet"
          body="MetaMask, Rabby, Coinbase… Choose “Ethereum Wallets” in the next step. You act from a NEAR account at your own 0x address."
          tag="Pays own gas"
        />
        <Option
          disabled={!NEAR_AUTH_ENABLED}
          title="Email, Google or passkey"
          body={NEAR_AUTH_ENABLED ? "No wallet needed." : "Through NEAR Auth. Not switched on yet: it needs a client ID issued by NEAR."}
          tag={NEAR_AUTH_ENABLED ? "No wallet" : "Soon"}
        />
        <Link
          href="/try"
          onClick={onClose}
          className="flex flex-col gap-1 rounded-tile border-[1.5px] border-dashed border-ink p-4 hover:bg-card"
        >
          <span className="flex items-center justify-between gap-2 font-semibold">
            Try as a test persona
            <span className="rounded-tag bg-ink px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-testnet">TESTNET</span>
          </span>
          <span className="text-sm text-muted">Get an owner, three guardians and two heirs with funded testnet accounts, and switch between them.</span>
        </Link>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </dialog>
  );
}

function Option({ title, body, tag, onClick, disabled }: { title: string; body: string; tag: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col gap-1 rounded-tile border-[1.5px] border-ink bg-card p-4 text-left hover:bg-mint disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-muted disabled:hover:bg-transparent"
    >
      <span className="flex items-center justify-between gap-2 font-semibold">
        {title}
        <span className="rounded-full border border-current px-2 py-0.5 font-mono text-[10.5px] font-bold uppercase">{tag}</span>
      </span>
      <span className="text-sm opacity-80">{body}</span>
    </button>
  );
}
