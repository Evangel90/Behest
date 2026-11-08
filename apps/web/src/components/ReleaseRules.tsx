"use client";
// Release rules (contract D17): fixed amounts, remainder, alternates and the
// fallback. Everyone sees them in plain words; the owner edits them while no
// release is open; anyone can move a share nobody claimed in time.
import { useCallback, useEffect, useState } from "react";
import { parseEther, parseUnits } from "viem";
import { getBtcDestinations, getConfig, view as viewCall } from "@/lib/contract";
import { describeRules, formatAmount, nextHolder, parseNear, relative, shortName, tokenOf } from "@/lib/plan";
import type { Asset, ContractConfig, PlanView, Recipient, ReleaseRules } from "@/lib/types";
import { Bracket, Button, Card, Field, Notice, inputClass } from "./ui";

type Act = (label: string, method: string, args: Record<string, unknown>, deposit?: bigint) => unknown;

/** Accounts with a Bitcoin destination in this plan (D20). */
export function useBtcDests(owner: string) {
  const [d, setD] = useState<string[]>([]);
  useEffect(() => void getBtcDestinations(owner).then((x) => setD(x.map((y) => y.account_id))).catch(() => {}), [owner]);
  return d;
}

export function useRules(owner: string) {
  const [rules, setRules] = useState<ReleaseRules | null | undefined>(undefined);
  const load = useCallback(() => viewCall<ReleaseRules | null>("get_release_rules", { owner }).then(setRules).catch(() => setRules(null)), [owner]);
  useEffect(() => void load(), [load]);
  return { rules, reload: load };
}

/** Unclaimed shares that can be moved now, with a button for each. */
export function Reassign({ view, now, rules, act, busy, signedIn }: { view: PlanView; now: number; rules: ReleaseRules | null | undefined; act: Act; busy: boolean; signedIn: boolean }) {
  const transfers = view.plan.proposal?.transfers ?? [];
  const btcDests = useBtcDests(view.plan.owner);
  const moves = transfers.map((t, i) => ({ t, i, next: nextHolder(view, rules ?? null, t, btcDests) })).filter((m) => m.next);
  if (moves.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="font-semibold">Unclaimed shares</span>
      {moves.map(({ t, i, next }) => {
        const ready = now >= next!.from_ms;
        return (
          <div key={i} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              {formatAmount(t)} for {shortName(t.heir)} → {next!.to.account_id} <span className="text-muted">({ready ? "can move now" : `from ${relative(next!.from_ms, now)}`})</span>
            </span>
            <Button variant="outline" disabled={busy || !ready || !signedIn} onClick={() => act(`Move ${shortName(t.heir)}'s share`, "reassign_unclaimed", { owner: view.plan.owner, index: i })}>
              Move share
            </Button>
          </div>
        );
      })}
      {!signedIn && <span className="text-xs text-muted">Anyone signed in can move a share once its claim window has passed.</span>}
    </div>
  );
}

/** Read-only summary plus, for the owner, the editor. */
export function RulesCard({ view, now, rules, editable, act, busy, signedIn }: { view: PlanView; now: number; rules: ReleaseRules | null | undefined; editable: boolean; act: Act; busy: boolean; signedIn: boolean }) {
  const [editing, setEditing] = useState(false);
  const lines = describeRules(rules ?? null);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Bracket>Release rules</Bracket>
        {editable && !editing && (
          <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            {rules ? "Edit" : "Add rules"}
          </Button>
        )}
      </div>
      {rules === undefined ? (
        <span className="text-sm text-muted">Reading…</span>
      ) : lines.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <span className="text-sm text-muted">None. Everything is split by share, rounding leftovers stay in the plan, and unclaimed shares wait for their heir.</span>
      )}
      {editing && <RulesEditor view={view} initial={rules ?? null} busy={busy} onCancel={() => setEditing(false)} onSave={(r) => (setEditing(false), act(r ? "Save release rules" : "Clear release rules", "set_release_rules", { rules: r }, r ? 10n ** 22n : undefined))} />}
      <Reassign view={view} now={now} rules={rules} act={act} busy={busy} signedIn={signedIn} />
    </Card>
  );
}

const emptyRecipient = { account_id: "", near_destination: "", eth_destination: "" };
type RecipientDraft = typeof emptyRecipient;
const toDraft = (r: Recipient | null | undefined): RecipientDraft => (r ? { account_id: r.account_id, near_destination: r.near_destination ?? "", eth_destination: r.eth_destination ?? "" } : emptyRecipient);
const fromDraft = (d: RecipientDraft): Recipient | null =>
  d.account_id.trim() ? { account_id: d.account_id.trim(), near_destination: d.near_destination.trim() || null, eth_destination: d.eth_destination.trim().toLowerCase() || null } : null;

const assetKey = (a: Asset) => (typeof a === "string" ? a : "Erc20" in a ? `erc20:${a.Erc20}` : `nep141:${a.Nep141}`);
const keyAsset = (k: string): Asset => (k === "Near" || k === "Eth" || k === "Btc" ? k : k.startsWith("erc20:") ? { Erc20: k.slice(6) } : { Nep141: k.slice(7) });

function parseAmount(text: string, asset: Asset): bigint {
  if (asset === "Near") return parseNear(text);
  if (asset === "Eth") return parseEther(text.trim());
  const t = tokenOf(asset);
  if (!t) throw new Error("unknown token");
  return parseUnits(text.trim(), t.decimals);
}

function unitsToText(amount: string, asset: Asset) {
  return formatAmount({ asset, amount }).split(" ")[0]!.replace(/,/g, "");
}

function RulesEditor({ view, initial, busy, onCancel, onSave }: { view: PlanView; initial: ReleaseRules | null; busy: boolean; onCancel: () => void; onSave: (r: ReleaseRules | null) => void }) {
  const heirs = view.plan.policy.heirs;
  const btcDests = useBtcDests(view.plan.owner);
  const [config, setConfig] = useState<ContractConfig | null>(null);
  useEffect(() => void getConfig().then(setConfig).catch(() => setConfig(null)), []);
  const [fixed, setFixed] = useState(initial?.fixed.map((f) => ({ heir: f.heir, asset: assetKey(f.asset), amount: unitsToText(f.amount, f.asset) })) ?? []);
  const [remainder, setRemainder] = useState(initial?.remainder_to ?? "");
  const [alts, setAlts] = useState<Record<string, RecipientDraft>>(Object.fromEntries(heirs.map((h) => [h.account_id, toDraft(initial?.alternates.find((a) => a.heir === h.account_id)?.recipient)])));
  const [fallback, setFallback] = useState(toDraft(initial?.fallback));
  const [windowDays, setWindowDays] = useState(initial ? String(initial.claim_window_ms / 86_400_000) : "180");
  const [error, setError] = useState<string | null>(null);

  const assetsFor = (heir: string) => {
    const h = heirs.find((x) => x.account_id === heir);
    const out: { key: string; label: string }[] = [];
    if (h?.near_destination) {
      out.push({ key: "Near", label: "NEAR" });
      for (const t of config?.nep141_tokens ?? []) out.push({ key: `nep141:${t.account_id}`, label: t.symbol });
    }
    if (h?.eth_destination) {
      out.push({ key: "Eth", label: "ETH" });
      for (const t of config?.erc20_tokens ?? []) out.push({ key: `erc20:${t.address}`, label: t.symbol });
    }
    if (btcDests.includes(heir)) out.push({ key: "Btc", label: "BTC" });
    return out;
  };

  function save() {
    setError(null);
    try {
      const alternates = heirs.flatMap((h) => {
        const r = fromDraft(alts[h.account_id] ?? emptyRecipient);
        return r ? [{ heir: h.account_id, recipient: r }] : [];
      });
      const fb = fromDraft(fallback);
      const days = Number(windowDays);
      if ((alternates.length || fb) && !(days > 0)) throw new Error("Set a claim window in days.");
      const rules: ReleaseRules = {
        fixed: fixed.map((f) => {
          const asset = keyAsset(f.asset);
          const amount = parseAmount(f.amount, asset);
          if (amount <= 0n) throw new Error(`Fixed amount for ${shortName(f.heir)} must be more than 0.`);
          return { heir: f.heir, asset, amount: amount.toString() };
        }),
        remainder_to: remainder || null,
        alternates,
        fallback: fb,
        claim_window_ms: alternates.length || fb ? Math.round(days * 86_400_000) : 0,
      };
      onSave(rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const recipientFields = (d: RecipientDraft, set: (d: RecipientDraft) => void, label: string) => (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Field label={`${label}: account`}>
        <input className={inputClass} value={d.account_id} placeholder="name.testnet" onChange={(e) => set({ ...d, account_id: e.target.value, near_destination: d.near_destination || "" })} />
      </Field>
      <Field label="NEAR destination">
        <input className={inputClass} value={d.near_destination} placeholder="optional" onChange={(e) => set({ ...d, near_destination: e.target.value })} />
      </Field>
      <Field label="ETH address">
        <input className={`${inputClass} font-mono`} value={d.eth_destination} placeholder="optional 0x…" onChange={(e) => set({ ...d, eth_destination: e.target.value })} />
      </Field>
    </div>
  );

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-3">
      <div className="flex flex-col gap-2">
        <span className="font-semibold">Fixed amounts, paid before shares</span>
        {fixed.map((f, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field label="Heir">
              <select className={inputClass} value={f.heir} onChange={(e) => setFixed(fixed.map((x, j) => (j === i ? { ...x, heir: e.target.value, asset: assetsFor(e.target.value)[0]?.key ?? "Near" } : x)))}>
                {heirs.map((h) => (
                  <option key={h.account_id} value={h.account_id}>
                    {shortName(h.account_id)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Asset">
              <select className={inputClass} value={f.asset} onChange={(e) => setFixed(fixed.map((x, j) => (j === i ? { ...x, asset: e.target.value } : x)))}>
                {assetsFor(f.heir).map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount">
              <input className={`${inputClass} w-32`} inputMode="decimal" value={f.amount} onChange={(e) => setFixed(fixed.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            </Field>
            <Button variant="outline" onClick={() => setFixed(fixed.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" className="self-start" onClick={() => setFixed([...fixed, { heir: heirs[0]!.account_id, asset: assetsFor(heirs[0]!.account_id)[0]?.key ?? "Near", amount: "1" }])}>
          Add a fixed amount
        </Button>
      </div>

      <Field label="Rounding leftovers go to" hint="Otherwise a few units of each asset stay in the plan.">
        <select className={inputClass} value={remainder} onChange={(e) => setRemainder(e.target.value)}>
          <option value="">Nobody (stay in the plan)</option>
          {heirs.map((h) => (
            <option key={h.account_id} value={h.account_id}>
              {shortName(h.account_id)}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-3">
        <span className="font-semibold">If a heir doesn't claim</span>
        <Field label="Claim window (days)" hint="How long each person has to claim before their share can be moved on.">
          <input className={`${inputClass} w-32`} inputMode="decimal" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
        </Field>
        {heirs.map((h) => (
          <div key={h.account_id}>{recipientFields(alts[h.account_id] ?? emptyRecipient, (d) => setAlts({ ...alts, [h.account_id]: d }), `Alternate for ${shortName(h.account_id)}`)}</div>
        ))}
        {recipientFields(fallback, setFallback, "Fallback for anything left")}
        <span className="text-xs text-muted">Alternates and the fallback must not be you, a heir or a guardian. Each receives only on chains where they have a destination; a share they can't receive stays where it is.</span>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={save}>
          Save rules
        </Button>
        {initial && (
          <Button variant="outline" disabled={busy} onClick={() => onSave(null)}>
            Remove all rules
          </Button>
        )}
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="text-xs text-muted">Rules can't change while a release is open. Saving attaches 0.01 NEAR for storage; what isn't used is refunded.</span>
    </div>
  );
}
