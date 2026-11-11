"use client";
// D27: receiving through NEAR Intents. A heir the owner opted in is paid into
// their account inside the Intents verifier. This card shows what they hold
// there (mt_batch_balance_of), lets them withdraw to a NEAR account, and on
// mainnet swap it to almost any asset on almost any chain through 1Click
// (depositType INTENTS, signed NEP-413 or ERC-191, no app fee). On testnet
// the verifier is a mock: balances and withdrawals work, swaps don't exist.
import { ArrowDownToLine, ArrowLeftRight, Link2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "@/lib/fees";
import { humanError } from "@/lib/hooks";
import {
  bridgeDepositAddress,
  getIntentsConfig,
  getIntentsDelivery,
  intentTokens,
  intentsAvailable,
  intentsBalances,
  intentsQuote,
  intentsTarget,
  publishIntent,
  signIntents,
  status as intentStatus,
  type IntentQuote,
  type IntentStatus,
  type IntentToken,
  type IntentsConfig,
} from "@/lib/intents";
import { formatToken, shortName, tokenOf } from "@/lib/plan";
import { useSession } from "@/lib/session";
import { Dialog, Field } from "./interactive";
import { useTx } from "./tx";
import { Button, Card, Notice, SectionTitle, Skeleton, inputClass } from "./ui";

interface Holding {
  token: string;
  symbol: string;
  decimals: number;
  amount: bigint;
}

const SWAP_WORDS: Record<IntentStatus, string> = {
  PENDING_DEPOSIT: "Waiting for the transfer inside Intents",
  KNOWN_DEPOSIT_TX: "Transfer seen, waiting for confirmations",
  PROCESSING: "Swapping and sending",
  SUCCESS: "Delivered.",
  INCOMPLETE_DEPOSIT: "The transfer was short; the rest is refunded to your Intents account.",
  REFUNDED: "Refunded to your Intents account. Nothing was swapped.",
  FAILED: "The swap failed. Funds are refunded to your Intents account.",
};

function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

/** The heir's NEAR Intents account and what it holds, or nothing if they weren't opted in. */
export function useIntentsHolding(owner: string, me: string | null, nearDestination?: string | null) {
  const cfg = useConfig();
  const [intents, setIntents] = useState<IntentsConfig | null | undefined>(undefined);
  const [target, setTarget] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<Holding[] | null | undefined>(undefined);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!me) return;
    let live = true;
    Promise.all([getIntentsConfig(), getIntentsDelivery(owner)])
      .then(async ([c, ds]) => {
        if (!live) return;
        setIntents(c);
        const t = c ? intentsTarget(ds, me, nearDestination) : null;
        setTarget(t);
        if (!c || !t) return setHoldings([]);
        const fts = (cfg?.nep141_tokens ?? []).map((x) => x.account_id);
        const tokens = [c.wnear, ...fts.filter((x) => x !== c.wnear)];
        const bal = await intentsBalances(c.verifier, t, tokens);
        if (!live) return;
        setHoldings(
          tokens.map((token) => {
            const meta = token === c.wnear ? { symbol: "wNEAR", decimals: 24 } : (tokenOf({ Nep141: token }) ?? { symbol: token, decimals: 0 });
            return { token, symbol: meta.symbol, decimals: meta.decimals, amount: bal[token] ?? 0n };
          }),
        );
      })
      .catch(() => live && setHoldings(null));
    return () => {
      live = false;
    };
  }, [owner, me, nearDestination, cfg, n]);
  return { intents, target, holdings, reload };
}

export function HeirIntentsCard({ owner, holding }: { owner: string; holding: ReturnType<typeof useIntentsHolding> }) {
  const { session } = useSession();
  const { intents, target, holdings, reload } = holding;
  const [dlg, setDlg] = useState<null | "withdraw" | "swap">(null);
  if (intents === undefined) return null;
  if (!intents || !target) return null;
  const mine = session?.accountId === target;
  const evm = session?.kind === "evm";
  const held = (holdings ?? []).filter((h) => h.amount > 0n);
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={Sparkles}
        title="Received through NEAR Intents"
        sub={
          <>
            {shortName(owner)} chose to pay your share into your NEAR Intents account <span className="font-mono text-xs">{target}</span>. From there you can keep it, withdraw it or swap it.
            {!intentsAvailable && " On testnet this is a stand-in for Intents: balances and withdrawals are real, swaps aren't."}
          </>
        }
      />
      {holdings === undefined || holdings === null ? (
        holdings === null ? (
          <Notice tone="warn">Couldn&apos;t read your Intents balance just now.</Notice>
        ) : (
          <Skeleton className="h-12 w-full" />
        )
      ) : held.length === 0 ? (
        <p className="text-[15px] text-muted">Nothing in your Intents account yet. Payments land here as each transfer confirms.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Your NEAR Intents balance">
          {held.map((h) => (
            <li key={h.token} className="flex items-baseline justify-between rounded-row bg-subtle px-4 py-2.5">
              <span className="text-sm font-semibold">{h.symbol}</span>
              <span className="font-mono text-sm">{formatToken(h.amount, h)}</span>
            </li>
          ))}
        </ul>
      )}
      {!mine ? (
        <p className="text-sm text-muted">Sign in as {target} to withdraw or swap it.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" icon={ArrowDownToLine} disabled={!held.length || (evm && !intentsAvailable)} onClick={() => setDlg("withdraw")}>
            Withdraw
          </Button>
          <Button variant="outline" size="sm" icon={ArrowLeftRight} disabled={!held.length || !intentsAvailable} onClick={() => setDlg("swap")} title={intentsAvailable ? undefined : "Swaps run on mainnet only"}>
            Swap
          </Button>
        </div>
      )}
      {mine && !intentsAvailable && <p className="text-[13px] text-muted">Swaps go through NEAR Intents&apos; 1Click on mainnet; there is no testnet for it.{evm && " An Ethereum wallet withdraws with a signed intent, which also needs mainnet."}</p>}
      {dlg === "withdraw" && <WithdrawDialog cfg={intents} me={target} held={held} onClose={() => setDlg(null)} done={reload} />}
      {dlg === "swap" && <SwapDialog cfg={intents} me={target} held={held} onClose={() => setDlg(null)} done={reload} />}
    </Card>
  );
}

function TokenPick({ held, value, onChange }: { held: Holding[]; value: string; onChange: (t: string) => void }) {
  return (
    <Field label="Token">
      {(p) => (
        <select {...p} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {held.map((h) => (
            <option key={h.token} value={h.token}>
              {h.symbol} · {formatToken(h.amount, h)} available
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function WithdrawDialog({ cfg, me, held, onClose, done }: { cfg: IntentsConfig; me: string; held: Holding[]; onClose: () => void; done: () => void }) {
  const { session } = useSession();
  const { busy, act, run } = useTx(done);
  const [token, setToken] = useState(held[0]?.token ?? "");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(session?.kind === "evm" ? "" : me);
  const h = held.find((x) => x.token === token);
  const raw = h ? parseUnits(amount, h.decimals) : null;
  const bad = !h || raw === null || raw <= 0n || raw > h.amount || !to.trim();
  async function submit() {
    if (bad || !session) return;
    // A NEAR account withdraws by calling the verifier itself; a 0x account signs an ft_withdraw intent.
    const ok =
      session.kind === "evm"
        ? await run("Withdraw from NEAR Intents", async () => {
            const signed = await signIntents(session, cfg.verifier, [{ intent: "ft_withdraw", token, receiver_id: to.trim(), amount: raw!.toString() }]);
            await publishIntent(signed);
          })
        : await act("Withdraw from NEAR Intents", "ft_withdraw", { token, receiver_id: to.trim(), amount: raw!.toString() }, { receiverId: cfg.verifier, deposit: 1n, tgas: 60, done: "Withdrawn. It lands in a few seconds." });
    if (ok) onClose();
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Withdraw from NEAR Intents"
      description="Sends tokens from your Intents account to a NEAR account. The receiving account must already hold (be registered with) that token."
      footer={
        <Button variant="ink" loading={!!busy} disabled={bad} onClick={submit}>
          Withdraw
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <TokenPick held={held} value={token} onChange={setToken} />
        <Field label="Amount" error={amount && bad && raw !== null && h && raw > h.amount ? "More than you hold." : amount && raw === null ? "Not a valid amount." : null}>
          {(p) => <input {...p} className={inputClass} inputMode="decimal" value={amount} placeholder={h ? formatToken(h.amount, h) : "0"} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="To NEAR account">{(p) => <input {...p} className={inputClass} value={to} spellCheck={false} autoCapitalize="none" onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function SwapDialog({ cfg, me, held, onClose, done }: { cfg: IntentsConfig; me: string; held: Holding[]; onClose: () => void; done: () => void }) {
  const { session } = useSession();
  const [token, setToken] = useState(held[0]?.token ?? "");
  const [amount, setAmount] = useState("");
  const [dests, setDests] = useState<IntentToken[] | null>(null);
  const [dest, setDest] = useState("");
  const [to, setTo] = useState("");
  const [quote, setQuote] = useState<(IntentQuote & { amountOutFormatted?: string }) | null>(null);
  const [state, setState] = useState<IntentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    intentTokens()
      .then((ts) => {
        setDests(ts);
        setDest(ts[0]?.assetId ?? "");
      })
      .catch((e) => setErr(humanError(e)));
  }, []);
  const h = held.find((x) => x.token === token);
  const raw = h ? parseUnits(amount, h.decimals) : null;
  const target = dests?.find((t) => t.assetId === dest);
  const bad = !h || raw === null || raw <= 0n || raw > h.amount || !target || !to.trim();

  // Poll the swap once it's sent.
  useEffect(() => {
    if (!quote?.depositAddress || !state || ["SUCCESS", "REFUNDED", "FAILED"].includes(state)) return;
    const t = setTimeout(() => void intentStatus(quote.depositAddress).then(setState).catch(() => {}), 5_000);
    return () => clearTimeout(t);
  }, [quote, state]);

  async function preview() {
    if (bad) return;
    setErr(null);
    setBusy(true);
    try {
      setQuote(await intentsQuote({ origin: `nep141:${token}`, dest: target!, amount: raw!, intentsAccount: me, recipient: to, dry: true }));
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (bad || !session) return;
    setErr(null);
    setBusy(true);
    try {
      const q = await intentsQuote({ origin: `nep141:${token}`, dest: target!, amount: raw!, intentsAccount: me, recipient: to });
      setQuote(q);
      // Move the tokens inside Intents to 1Click's deposit address; 1Click swaps and delivers.
      const signed = await signIntents(session, cfg.verifier, [{ intent: "transfer", receiver_id: q.depositAddress, tokens: { [`nep141:${token}`]: raw!.toString() } }]);
      await publishIntent(signed);
      setState("PENDING_DEPOSIT");
      done();
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Swap from NEAR Intents"
      description="Swap what you hold in Intents to another asset and have it delivered to an address on its own chain. Behest takes no fee on this."
      footer={
        state ? (
          <Button variant="ink" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" loading={busy && !quote} disabled={bad} onClick={preview}>
              Get a quote
            </Button>
            <Button variant="ink" loading={busy && !!quote} disabled={bad || !quote} onClick={send}>
              Swap
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <TokenPick held={held} value={token} onChange={(t) => (setToken(t), setQuote(null))} />
        <Field label="Amount">{(p) => <input {...p} className={inputClass} inputMode="decimal" value={amount} onChange={(e) => (setAmount(e.target.value), setQuote(null))} />}</Field>
        <Field label="Receive">
          {(p) =>
            dests ? (
              <select {...p} className={inputClass} value={dest} onChange={(e) => (setDest(e.target.value), setQuote(null))}>
                {dests.map((t) => (
                  <option key={t.assetId} value={t.assetId}>
                    {t.symbol} on {t.blockchain}
                  </option>
                ))}
              </select>
            ) : (
              <Skeleton className="h-12 w-full" />
            )
          }
        </Field>
        <Field label={target ? `${target.blockchain} address` : "Address"}>{(p) => <input {...p} className={`${inputClass} font-mono text-sm`} value={to} spellCheck={false} autoCapitalize="none" onChange={(e) => (setTo(e.target.value), setQuote(null))} />}</Field>
        {quote && !state && (
          <Notice tone="info" title={`About ${quote.amountOutFormatted ?? "?"} ${target?.symbol ?? ""}`}>
            Arrives in about {Math.max(1, Math.round(quote.timeEstimate / 60))} minute{quote.timeEstimate > 90 ? "s" : ""}. Anything that can&apos;t be filled is refunded to your Intents account.
          </Notice>
        )}
        {state && <Notice tone={state === "SUCCESS" ? "ok" : ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(state) ? "warn" : "info"}>{SWAP_WORDS[state]}</Notice>}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Dialog>
  );
}

/**
 * ETH and Bitcoin: no contract change. On mainnet a heir can save an Intents
 * bridge deposit address as their destination, so the vault's payout lands
 * in their Intents account. Testnet has no bridge, so this only explains it.
 */
export function IntentsBridgeAddress({ account, chain, onUse }: { account: string; chain: "eth:1" | "btc:mainnet"; onUse: (address: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const label = chain === "eth:1" ? "Ethereum" : "Bitcoin";
  if (!intentsAvailable) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" className="inline-flex items-center gap-1.5 self-start text-[13px] font-semibold text-signal" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Link2 aria-hidden className="size-3.5" />
          Receive {label} into NEAR Intents?
        </button>
        {open && <p className="text-[13px] text-muted">On mainnet, Behest can fill in a NEAR Intents bridge deposit address for {account || "this heir"}: {label} sent there lands in their Intents account. Testnet has no Intents bridge, so this isn&apos;t available here.</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon={Link2}
        loading={busy}
        disabled={!account}
        className="self-start"
        onClick={async () => {
          setErr(null);
          setBusy(true);
          try {
            onUse(await bridgeDepositAddress(account, chain));
          } catch (e) {
            setErr(humanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Use a NEAR Intents {label} deposit address
      </Button>
      {err && <span className="text-[13px] font-semibold text-error">{err}</span>}
    </div>
  );
}
