"use client";
import Link from "next/link";
import { ArrowLeft, ArrowRight, FlaskConical, Hexagon, Landmark, Mail, Puzzle, Smartphone, Wallet, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { humanError } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { CopyButton, Dialog } from "./interactive";
import { QrCode } from "./QrCode";
import { Notice, TestnetTag, cx } from "./ui";
import { BehestLoader } from "./BehestLoader";

const NEAR_AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_NEAR_AUTH_CLIENT_ID);
const WC_ENABLED = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

interface FoundWallet {
  id: string;
  name: string;
  icon?: string;
}

type View = "main" | "evm" | "qr";
/** Set when someone chose "A DAO or multisig": the account menu opens the DAO picker once signed in. */
export const PICK_DAO = "behest.pick-dao";

export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connectWallet, connectEvm } = useSession();
  const [view, setView] = useState<View>("main");
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<FoundWallet[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const qrCancelled = useRef(false);

  // Start on the first screen each time, unless a wallet request is still open.
  useEffect(() => {
    if (open && !pending) {
      setView("main");
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find browser-extension wallets (EIP-6963) once the Ethereum list is shown.
  useEffect(() => {
    if (!open || view === "main") return;
    let stop = () => {};
    let off = false;
    void import("@/lib/evm/wallets").then(({ watchWallets, injectedWallets }) => {
      if (off) return;
      const read = () => setWallets(injectedWallets().map(({ info }) => ({ id: info.id, name: info.name, icon: info.icon })));
      stop = watchWallets(read);
      read();
    });
    return () => {
      off = true;
      stop();
    };
  }, [open, view]);

  async function nearWallet(thenDao = false) {
    setError(null);
    try {
      if (thenDao) sessionStorage.setItem(PICK_DAO, "1");
      else sessionStorage.removeItem(PICK_DAO);
    } catch {}
    try {
      onClose();
      await connectWallet();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.");
    }
  }

  async function evmWallet(id: string) {
    // One wallet request at a time: a second eth_requestAccounts is declined by MetaMask.
    if (pending) return;
    setError(null);
    setPending(id);
    if (id === "walletconnect") {
      qrCancelled.current = false;
      setUri(null);
      setView("qr");
    }
    try {
      await connectEvm(id, { onUri: setUri });
      setView("main");
      onClose();
    } catch (e) {
      if (id === "walletconnect") setView("evm");
      if (!(id === "walletconnect" && qrCancelled.current)) setError(humanError(e));
    } finally {
      setPending(null);
      setUri(null);
    }
  }

  async function cancelQr() {
    qrCancelled.current = true;
    (await import("@/lib/evm/wallets")).cancelConnect();
    setView("evm");
  }

  const close = () => {
    if (view === "qr") void cancelQr();
    onClose();
  };

  if (view === "evm" || view === "qr") {
    const qr = view === "qr";
    return (
      <Dialog
        open={open}
        onClose={close}
        title={qr ? "Scan with your phone" : "Ethereum wallet"}
        description={qr ? "Open a WalletConnect wallet (MetaMask, Rainbow, Trust, Zerion…) and scan this code." : "You act from the NEAR account at your own 0x address. Each action asks you to sign a readable message; Behest pays the gas."}
      >
        <button
          type="button"
          onClick={() => (qr ? void cancelQr() : setView("main"))}
          className="-mt-1 inline-flex min-h-9 items-center gap-1.5 self-start rounded-full pr-3 text-sm text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {qr ? "Other wallets" : "All sign-in options"}
        </button>
        {qr ? (
          <WalletConnectQr uri={uri} />
        ) : (
          <div className="flex flex-col gap-2">
            {wallets === null ? (
              <WalletRow icon={<BehestLoader size={20} label="Looking for browser wallets" />} title="Looking for browser wallets…" disabled />
            ) : wallets.length === 0 ? (
              <div className="flex items-start gap-3 rounded-row border border-dashed border-line-strong p-4">
                <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-subtle text-muted">
                  <Puzzle className="size-5" />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="font-semibold">No browser wallet found</span>
                  <span className="text-sm text-muted">Install MetaMask, Rabby or Coinbase Wallet and reload this page{WC_ENABLED ? ", or use a phone wallet below" : ""}.</span>
                </span>
              </div>
            ) : (
              wallets.map((w) => (
                <WalletRow
                  key={w.id}
                  icon={w.icon ? <img src={w.icon} alt="" className="size-7 rounded-md" /> : <Hexagon aria-hidden className="size-5" />}
                  title={w.name}
                  body={pending === w.id ? `Approve in ${w.name}. If nothing opened, click its icon in your browser's toolbar.` : "Browser extension"}
                  tag={pending === w.id ? "Waiting…" : "Detected"}
                  loading={pending === w.id}
                  disabled={!!pending && pending !== w.id}
                  onClick={() => void evmWallet(w.id)}
                />
              ))
            )}
            {WC_ENABLED && (
              <WalletRow
                icon={<Smartphone aria-hidden className="size-5" />}
                title="Phone wallet"
                body="Scan a QR code with MetaMask Mobile, Rainbow, Trust or any WalletConnect wallet."
                tag="WalletConnect"
                disabled={!!pending}
                onClick={() => void evmWallet("walletconnect")}
              />
            )}
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <p className="text-xs leading-relaxed text-muted">Signing in shares only your address. Behest never asks for a transaction or a network switch, and an Ethereum wallet can&apos;t attach NEAR: funding happens by sending to your plan&apos;s vaults.</p>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} title="Sign in" description="Behest never holds your keys. Pick whatever you already use.">
      <div className="flex flex-col gap-2">
        <Option icon={Wallet} onClick={() => void nearWallet()} title="NEAR wallet" body="HOT, Meteor, Intear, MyNearWallet, Ledger and more." tag="Gas sponsored" />
        <Option
          icon={Hexagon}
          onClick={() => {
            setError(null);
            setView("evm");
          }}
          title="Ethereum wallet"
          body="MetaMask, Rabby, Coinbase Wallet, or a phone wallet. You act from a NEAR account at your own 0x address."
          tag="Gas sponsored"
        />
        <Option
          icon={Landmark}
          onClick={() => void nearWallet(true)}
          title="A DAO or multisig"
          body="Sign in as a council member with a NEAR wallet, then pick the SputnikDAO (Trezu) you act for. Each action becomes a proposal."
          tag="Proposals"
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

function WalletConnectQr({ uri }: { uri: string | null }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex size-[248px] items-center justify-center rounded-card border border-line bg-white p-4" aria-live="polite">
        {uri ? <QrCode value={uri} label="WalletConnect pairing code" className="size-full text-[#0A0A0A]" /> : <BehestLoader size={48} label="Preparing the code" tone="light" />}
      </div>
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        {uri && <BehestLoader size={20} label="Waiting for your wallet" />}
        {uri ? "Waiting for your wallet to connect…" : "Preparing a pairing code…"}
      </p>
      {uri && (
        <div className="flex flex-wrap justify-center gap-2">
          <a href={uri} className="inline-flex min-h-11 items-center gap-2 rounded-tile bg-ink px-4 text-[15px] font-medium text-ink-contrast sm:hidden">
            <Smartphone aria-hidden className="size-[18px]" />
            Open wallet app
          </a>
          <span className="inline-flex min-h-11 items-center gap-1 rounded-tile border border-line px-2 text-sm text-muted">
            Copy link <CopyButton value={uri} label="Copy pairing link" />
          </span>
        </div>
      )}
    </div>
  );
}

function WalletRow({ icon, title, body, tag, onClick, disabled, loading }: { icon: ReactNode; title: string; body?: string; tag?: string; onClick?: () => void; disabled?: boolean; loading?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading || undefined}
      className={cx(
        "group flex items-center gap-3 rounded-row border bg-card p-4 text-left transition-[border,background,opacity] duration-150",
        loading ? "border-signal" : "border-line hover:border-signal",
        "disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-line",
      )}
    >
      <span aria-hidden className="relative flex size-10 shrink-0 items-center justify-center rounded-tile bg-subtle">
        {icon}
        {loading && <BehestLoader size={20} label="Connecting" className="absolute -right-1.5 -top-1.5 rounded-full bg-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center justify-between gap-2 font-semibold">
          {title}
          {tag && <span className={cx("inline-flex h-6 items-center rounded-tag px-2 text-xs font-semibold", loading ? "bg-s-approved text-[var(--s-approved-fg)]" : "bg-subtle text-muted")}>{tag}</span>}
        </span>
        {body && <span className="text-sm text-muted">{body}</span>}
      </span>
    </button>
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

