"use client";
// What someone signed in with an email holds, and the way out. A heir named
// by email receives into the account kept for that address; nothing else can
// spend from it, so this card is where they move it on to an exchange or a
// wallet of their own. One asset per row, one plain form per send.
import { ArrowUpRight, CircleCheck, Mail, Wallet } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatUnits, parseUnits, type Hex } from "viem";
import { BTC_EXPLORER, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { btcUtxos, ethBalance, getConfig, nearBalance, tokenBalances } from "@/lib/contract";
import { humanError } from "@/lib/hooks";
import { formatBtc, formatEth, formatNear, formatToken, shortAddr } from "@/lib/plan";
import {
  NEAR_FEE_RESERVE,
  NEAR_TOKEN_FEE_RESERVE,
  SendError,
  btcFeeRate,
  checkBtcAddress,
  checkNearDestination,
  ethFee,
  nep141Balance,
  planBtc,
  sendBtc,
  sendErc20,
  sendEth,
  sendNear,
  sendNep141,
  type EthFee,
} from "@/lib/sendout";
import { useSession } from "@/lib/session";
import type { Erc20Token, Nep141Token } from "@/lib/types";
import { Address, Dialog, Disclosure, Field } from "./interactive";
import { Button, Card, ExtLink, Notice, SectionTitle, Skeleton, TickerDisc, cx, inputClass } from "./ui";

type Asset =
  | { kind: "near"; symbol: "NEAR"; decimals: 24; balance: bigint }
  | { kind: "nep141"; symbol: string; decimals: number; balance: bigint; token: Nep141Token }
  | { kind: "eth"; symbol: "ETH"; decimals: 18; balance: bigint }
  | { kind: "erc20"; symbol: string; decimals: number; balance: bigint; token: Erc20Token }
  | { kind: "btc"; symbol: "BTC"; decimals: 8; balance: bigint; coins: { txid: string; vout: number; value: string }[] };

const CHAIN: Record<Asset["kind"], { ticker: "NEAR" | "ETH" | "BTC"; name: string; where: string; placeholder: string }> = {
  near: { ticker: "NEAR", name: "NEAR", where: "a NEAR account", placeholder: "you.testnet, or an exchange's deposit account" },
  nep141: { ticker: "NEAR", name: "NEAR", where: "a NEAR account", placeholder: "you.testnet" },
  eth: { ticker: "ETH", name: "Ethereum (Sepolia)", where: "an Ethereum address", placeholder: "0x…" },
  erc20: { ticker: "ETH", name: "Ethereum (Sepolia)", where: "an Ethereum address", placeholder: "0x…" },
  btc: { ticker: "BTC", name: "Bitcoin (testnet)", where: "a Bitcoin address", placeholder: "tb1q…" },
};

const show = (a: Asset, v = a.balance) => (a.kind === "near" ? formatNear(v) : a.kind === "eth" ? formatEth(v) : a.kind === "btc" ? formatBtc(v) : formatToken(v, a));

/** Balances of the three wallets that come with an email sign-in. Null while loading. */
export function useEmailAssets() {
  const { session } = useSession();
  const w = session?.email;
  const eth = session?.accountId as Hex | undefined;
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!w || !eth) return;
    try {
      const cfg = await getConfig();
      const nep = cfg.nep141_tokens ?? [];
      const [near, nepBal, wei, ercBal, coins] = await Promise.all([
        nearBalance(w.near),
        Promise.all(nep.map((t) => nep141Balance(t.account_id, w.near))),
        ethBalance(eth),
        tokenBalances(eth, cfg.erc20_tokens),
        btcUtxos(w.btc).catch(() => []),
      ]);
      setAssets([
        { kind: "near", symbol: "NEAR", decimals: 24, balance: near ?? 0n },
        ...nep.map((token, i): Asset => ({ kind: "nep141", symbol: token.symbol, decimals: token.decimals, balance: nepBal[i] ?? 0n, token })),
        { kind: "eth", symbol: "ETH", decimals: 18, balance: wei },
        ...cfg.erc20_tokens.map((token, i): Asset => ({ kind: "erc20", symbol: token.symbol, decimals: token.decimals, balance: ercBal[i] ?? 0n, token })),
        { kind: "btc", symbol: "BTC", decimals: 8, balance: coins.reduce((s, c) => s + BigInt(c.value), 0n), coins },
      ]);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [w, eth]);
  useEffect(() => {
    setAssets(null);
    if (!w) return;
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [w, load]);
  return { wallet: w, eth, assets, failed, reload: load };
}

/** The signed-in person's email account: what arrived, and a way to send it on. Renders nothing for other sign-ins. */
export function EmailAccountCard({ className }: { className?: string }) {
  const { wallet, eth, assets, failed, reload } = useEmailAssets();
  const [sending, setSending] = useState<Asset | null>(null);
  if (!wallet || !eth) return null;
  const held = (assets ?? []).filter((a) => a.balance > 0n);
  const addressOf = (k: Asset["kind"]) => (k === "near" || k === "nep141" ? wallet.near : k === "btc" ? wallet.btc : eth);
  return (
    <Card className={cx("flex flex-col gap-4", className)}>
      <SectionTitle icon={Wallet} title="Your account" sub={`What you receive arrives here, in the account kept for ${wallet.email}. Send it on to an exchange or a wallet of your own whenever you like.`} />
      {assets === null && !failed && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading your balances">
          <Skeleton className="h-16 w-full rounded-row" />
          <Skeleton className="h-16 w-full rounded-row" />
        </div>
      )}
      {failed && assets === null && (
        <Notice tone="warn" action={<Button size="sm" variant="outline" onClick={() => void reload()}>Try again</Button>}>
          Couldn&apos;t read your balances just now. Nothing is lost: they are read straight from each network.
        </Notice>
      )}
      {assets && held.length === 0 && <p className="rounded-row bg-subtle px-4 py-3 text-[15px] text-muted">Nothing has arrived yet. When a share is paid to you it shows up here within a minute or two.</p>}
      {held.length > 0 && (
        <ul className="flex flex-col gap-2">
          {held.map((a) => (
            <li key={`${a.kind}:${a.symbol}`} className="flex animate-fade-up flex-wrap items-center gap-3 rounded-row border border-line bg-card p-4">
              <TickerDisc ticker={a.kind === "nep141" || a.kind === "erc20" ? a.symbol : CHAIN[a.kind].ticker} size={40} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[19px] font-semibold leading-tight">
                  {show(a)} {a.symbol}
                </span>
                <span className="text-[13px] text-muted">{CHAIN[a.kind].name}</span>
              </span>
              <Button variant="ink" size="sm" iconRight={ArrowUpRight} onClick={() => setSending(a)}>
                Send
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Disclosure icon={Mail} title="Your addresses" sub="Where each kind of asset arrives">
        <div className="flex flex-col gap-3 text-sm">
          {(["near", "eth", "btc"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-0.5">
              <span className="font-semibold">{CHAIN[k].name}</span>
              <Address value={addressOf(k)} href={k === "near" ? `${NEAR_EXPLORER}/address/${wallet.near}` : k === "eth" ? `${ETH_EXPLORER}/address/${eth}` : `${BTC_EXPLORER}/address/${wallet.btc}`} label={`${CHAIN[k].name} address`} />
            </div>
          ))}
          <p className="text-[13px] leading-relaxed text-muted">These are kept by Privy, a wallet service, and opened by your inbox: whoever can read {wallet.email} can spend from them. Moving what you receive to a wallet of your own ends that dependence.</p>
        </div>
      </Disclosure>
      {sending && <SendDialog asset={sending} onClose={() => setSending(null)} onSent={reload} />}
    </Card>
  );
}

const explorer = (a: Asset, hash: string) => (a.kind === "near" || a.kind === "nep141" ? `${NEAR_EXPLORER}/txns/${hash}` : a.kind === "btc" ? `${BTC_EXPLORER}/tx/${hash}` : `${ETH_EXPLORER}/tx/${hash}`);

function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  if ((t.split(".")[1] ?? "").length > decimals) return null;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

function SendDialog({ asset: a, onClose, onSent }: { asset: Asset; onClose: () => void; onSent: () => void }) {
  const { session } = useSession();
  const w = session?.email;
  const from = session?.accountId as Hex;
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  /** "Send everything": for NEAR, ETH and BTC the amount is whatever is left after the network fee. */
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fee, setFee] = useState<{ eth?: EthFee; btcRate?: number } | null>(null);
  const c = CHAIN[a.kind];

  // What the network will charge, read once when the form opens.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (a.kind === "btc") setFee({ btcRate: await btcFeeRate() });
        else if (a.kind === "eth") {
          const f = await ethFee(from, from);
          if (live) setFee({ eth: f });
        } else setFee({});
      } catch {
        if (live) setFee({});
      }
    })();
    return () => {
      live = false;
    };
  }, [a.kind, from]);

  // The most that can leave, after the fee this kind of transfer pays from the same balance.
  let max = a.balance;
  let feeLine = "";
  if (a.kind === "near") {
    max = a.balance > NEAR_FEE_RESERVE ? a.balance - NEAR_FEE_RESERVE : 0n;
    feeLine = "Network fee: under 0.001 NEAR, taken from this balance.";
  } else if (a.kind === "nep141") feeLine = `Network fee: under ${formatNear(NEAR_TOKEN_FEE_RESERVE)} NEAR, paid from your NEAR balance.`;
  else if (a.kind === "eth") {
    const f = fee?.eth;
    max = f && a.balance > f.max ? a.balance - f.max : f ? 0n : a.balance;
    feeLine = f ? `Network fee: at most ${formatEth(f.max)} ETH, taken from this balance.` : "Working out the network fee…";
  } else if (a.kind === "erc20") feeLine = "Network fee: a little ETH, paid from your ETH balance.";
  else if (a.kind === "btc" && fee?.btcRate) {
    try {
      const p = planBtc(a.coins, null, fee.btcRate);
      max = p.amount;
      feeLine = `Network fee: about ${formatBtc(p.fee)} BTC (${fee.btcRate} sat/vB), taken from this balance.`;
    } catch {
      max = 0n;
      feeLine = "There is too little here to cover the Bitcoin network fee.";
    }
  }
  const parsed = all ? max : parseAmount(amount, a.decimals);
  const amountError = !all && amount.trim() !== "" && (parsed === null ? `Enter an amount in ${a.symbol}, like ${formatUnits(max > 0n ? max / 2n : 10n ** BigInt(a.decimals), a.decimals).slice(0, 10)}.` : parsed > max ? `The most you can send is ${show(a, max)} ${a.symbol}.` : parsed <= 0n ? "Enter an amount above zero." : null);

  const checkTo = async (): Promise<boolean> => {
    const v = to.trim();
    let bad: string | null = null;
    if (!v) bad = `Enter ${c.where}.`;
    else if (a.kind === "btc") bad = checkBtcAddress(v);
    else if (a.kind === "eth" || a.kind === "erc20") bad = /^0x[0-9a-fA-F]{40}$/.test(v) ? null : "An Ethereum address is 0x followed by 40 characters.";
    else bad = await checkNearDestination(v);
    setToError(bad);
    return !bad;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!w || busy) return;
    setError(null);
    if (!(await checkTo())) return;
    if (parsed === null || parsed <= 0n || parsed > max) return setError(max === 0n ? "There isn't enough here to send once the network fee is set aside." : `Enter an amount up to ${show(a, max)} ${a.symbol}.`);
    setBusy(true);
    try {
      let hash: string;
      if (a.kind === "near") hash = await sendNear(w, to, parsed);
      else if (a.kind === "nep141") hash = await sendNep141(w, a.token, to, parsed);
      else if (a.kind === "eth") hash = await sendEth(w, from, to, parsed, fee?.eth ?? (await ethFee(from, from)));
      else if (a.kind === "erc20") hash = await sendErc20(w, from, a.token, to, parsed, await ethFee(from, to.trim() as Hex, { address: a.token.address as Hex, amount: parsed }));
      else hash = await sendBtc(w, to, all ? null : parsed, fee?.btcRate ?? (await btcFeeRate()));
      setDone(hash);
      onSent();
    } catch (err) {
      setError(err instanceof SendError ? err.message : humanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done !== null)
    return (
      <Dialog open onClose={onClose} title="Sent">
        <div className="flex flex-col items-start gap-3">
          <span className="flex items-center gap-2 text-lg font-semibold text-ok">
            <CircleCheck aria-hidden className="size-6" />
            {all ? "Everything" : `${show(a, parsed ?? 0n)} ${a.symbol}`} is on its way
          </span>
          <p className="text-[15px] leading-relaxed text-muted">
            To <span className="font-mono text-[13px] text-ink">{to.trim().length > 24 ? shortAddr(to.trim()) : to.trim()}</span>. {a.kind === "btc" ? "Bitcoin usually confirms within the hour." : "It usually arrives in under a minute."}
          </p>
          {done && (
            <ExtLink href={explorer(a, done)} className="text-sm font-semibold">
              View the transaction
            </ExtLink>
          )}
          <Button variant="ink" onClick={onClose} className="self-stretch">
            Done
          </Button>
        </div>
      </Dialog>
    );

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={`Send ${a.symbol}`} description={`You have ${show(a)} ${a.symbol}${a.kind === "near" ? "" : ` on ${c.name}`}. Once sent, a transfer can't be undone.`}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Send to" error={toError} hint={a.kind === "btc" ? "A testnet address from your own wallet or an exchange." : `Paste ${c.where} from your own wallet or an exchange.`}>
          {(p) => (
            <input
              {...p}
              className={cx(inputClass, "font-mono text-sm")}
              placeholder={c.placeholder}
              value={to}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              autoFocus
              disabled={busy}
              onChange={(e) => {
                setTo(e.target.value);
                setToError(null);
              }}
              onBlur={() => to.trim() && void checkTo()}
            />
          )}
        </Field>
        <Field label="Amount" error={amountError} hint={feeLine}>
          {(p) => (
            <div className="flex items-stretch gap-2">
              <div className="flex min-h-12 min-w-0 flex-1 items-center rounded-tile border border-line-strong bg-card px-3.5 focus-within:border-signal focus-within:ring-2 focus-within:ring-signal/25">
                <input
                  {...p}
                  className="min-w-0 flex-1 bg-transparent text-base outline-none disabled:opacity-60"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={all ? show(a, max) : amount}
                  disabled={busy || all}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <span className="pl-2 text-sm font-semibold text-muted">{a.symbol}</span>
              </div>
              <Button type="button" variant={all ? "ink" : "outline"} aria-pressed={all} disabled={busy} onClick={() => setAll((v) => !v)}>
                Everything
              </Button>
            </div>
          )}
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} disabled={max === 0n && fee !== null}>
          {busy ? "Sending" : all ? `Send all ${a.symbol}` : `Send ${a.symbol}`}
        </Button>
        <p className="text-xs leading-relaxed text-muted">Check the address twice. Behest can&apos;t reverse a transfer or recover funds sent to a wrong address.</p>
      </form>
    </Dialog>
  );
}
