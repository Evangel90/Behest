"use client";
// Release rules (contract D17): fixed amounts, remainder, alternates and the
// fallback. Everyone sees them in plain words; the owner edits them while no
// release is open; anyone can move a share nobody claimed in time.
import { ArrowRight, ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { parseEther, parseUnits } from "viem";
import { getBtcDestinations, getConfig, view as viewCall } from "@/lib/contract";
import { describeRules, formatAmount, nextHolder, parseNear, relative, shortName, tokenOf } from "@/lib/plan";
import type { Asset, ContractConfig, PlanView, Recipient, ReleaseRules } from "@/lib/types";
import { useConfirm } from "./feedback";
import { Dialog, Disclosure, Field, Term } from "./interactive";
import type { Act } from "./tx";
import { Button, IconButton, Notice, Skeleton, cx, inputClass } from "./ui";

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
  const confirm = useConfirm();
  const transfers = view.plan.proposal?.transfers ?? [];
  const btcDests = useBtcDests(view.plan.owner);
  const moves = transfers.map((t, i) => ({ t, i, next: nextHolder(view, rules ?? null, t, btcDests) })).filter((m) => m.next);
  if (moves.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-row border border-line p-4">
      <span className="font-semibold">Unclaimed shares</span>
      <ul className="flex flex-col divide-y divide-line">
        {moves.map(({ t, i, next }) => {
          const ready = now >= next!.from_ms;
          return (
            <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                {formatAmount(t)} for {shortName(t.heir)}
                <ArrowRight aria-hidden className="size-4 text-muted" />
                <span className="font-mono text-xs">{next!.to.account_id}</span>
                <span className="text-muted">({ready ? "can move now" : `from ${relative(next!.from_ms, now)}`})</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !ready || !signedIn}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Move ${shortName(t.heir)}'s share?`,
                      body: `${shortName(t.heir)} didn't claim within the window the owner set, so this share now goes to ${next!.to.account_id}. This can't be undone.`,
                      rows: [
                        ["Amount", formatAmount(t)],
                        ["New recipient", next!.to.account_id],
                      ],
                      confirmLabel: "Move share",
                    })
                  )
                    await act(`Move ${shortName(t.heir)}'s share`, "reassign_unclaimed", { owner: view.plan.owner, index: i }, { tgas: 50 });
                }}
              >
                Move share
              </Button>
            </li>
          );
        })}
      </ul>
      {!signedIn && <span className="text-xs text-muted">Anyone signed in can move a share once its claim window has passed.</span>}
    </div>
  );
}

/** Read-only summary plus, for the owner, the editor (in a dialog). */
export function RulesCard({
  view,
  now,
  rules,
  editable,
  act,
  busy,
  signedIn,
  onChanged,
  defaultOpen,
}: {
  view: PlanView;
  now: number;
  rules: ReleaseRules | null | undefined;
  editable: boolean;
  act: Act;
  busy: boolean;
  signedIn: boolean;
  onChanged?: () => unknown;
  defaultOpen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const lines = describeRules(rules ?? null);
  const save = async (r: ReleaseRules | null) => {
    const ok = await act(r ? "Save release rules" : "Clear release rules", "set_release_rules", { rules: r }, r ? { deposit: 10n ** 22n } : {});
    if (ok) {
      setEditing(false);
      await onChanged?.();
    }
  };
  return (
    <Disclosure
      id="rules"
      icon={ListChecks}
      title="Release rules"
      sub={rules === undefined ? "Reading…" : lines.length ? `${lines.length} rule${lines.length === 1 ? "" : "s"}` : "Split by share, nothing else"}
      defaultOpen={defaultOpen}
      aside={editable ? <IconButton icon={Pencil} label={rules ? "Edit release rules" : "Add release rules"} disabled={busy} onClick={() => setEditing(true)} /> : undefined}
    >
      {rules === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : lines.length ? (
        <ul className="flex flex-col gap-2">
          {lines.map((l) => (
            <li key={l} className="flex gap-2.5 text-[15px] leading-relaxed">
              <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-signal" />
              {l}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm leading-relaxed text-muted">None. Everything is split by share, rounding leftovers stay in the plan, and unclaimed shares wait for their heir.</p>
      )}
      {editable && (
        <Button variant="outline" size="sm" icon={rules ? Pencil : Plus} className="self-start" disabled={busy} onClick={() => setEditing(true)}>
          {rules ? "Edit rules" : "Add rules"}
        </Button>
      )}
      <Reassign view={view} now={now} rules={rules} act={act} busy={busy} signedIn={signedIn} />
      <Dialog open={editing} onClose={() => setEditing(false)} title="Release rules" description="Optional extras on top of the share split. They can't change while a release is open." size="lg">
        {editing && <RulesEditor view={view} initial={rules ?? null} busy={busy} onCancel={() => setEditing(false)} onSave={save} />}
      </Dialog>
    </Disclosure>
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
  const confirm = useConfirm();
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
    <fieldset className="grid grid-cols-1 gap-3 rounded-row border border-line p-3 sm:grid-cols-3">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <Field label="Account">{(p) => <input {...p} className={inputClass} value={d.account_id} placeholder="name.testnet" spellCheck={false} onChange={(e) => set({ ...d, account_id: e.target.value })} />}</Field>
      <Field label="NEAR destination" optional>
        {(p) => <input {...p} className={inputClass} value={d.near_destination} placeholder="name.testnet" spellCheck={false} onChange={(e) => set({ ...d, near_destination: e.target.value })} />}
      </Field>
      <Field label="ETH address" optional>
        {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} value={d.eth_destination} placeholder="0x…" spellCheck={false} onChange={(e) => set({ ...d, eth_destination: e.target.value })} />}
      </Field>
    </fieldset>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h3 className="font-semibold">Fixed amounts, paid before shares</h3>
        {fixed.length === 0 && <p className="text-sm text-muted">None. Add one to give someone a set amount first.</p>}
        {fixed.map((f, i) => (
          <div key={i} className={cx("grid grid-cols-2 items-end gap-2 rounded-row border border-line p-3 sm:grid-cols-[1fr_1fr_1fr_auto]", "animate-fade-up")}>
            <Field label="Heir">
              {(p) => (
                <select {...p} className={inputClass} value={f.heir} onChange={(e) => setFixed(fixed.map((x, j) => (j === i ? { ...x, heir: e.target.value, asset: assetsFor(e.target.value)[0]?.key ?? "Near" } : x)))}>
                  {heirs.map((h) => (
                    <option key={h.account_id} value={h.account_id}>
                      {shortName(h.account_id)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Asset">
              {(p) => (
                <select {...p} className={inputClass} value={f.asset} onChange={(e) => setFixed(fixed.map((x, j) => (j === i ? { ...x, asset: e.target.value } : x)))}>
                  {assetsFor(f.heir).map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Amount">{(p) => <input {...p} className={inputClass} inputMode="decimal" value={f.amount} onChange={(e) => setFixed(fixed.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />}</Field>
            <IconButton icon={Trash2} label={`Remove fixed amount ${i + 1}`} className="justify-self-end" onClick={() => setFixed(fixed.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button variant="outline" size="sm" icon={Plus} className="self-start" onClick={() => setFixed([...fixed, { heir: heirs[0]!.account_id, asset: assetsFor(heirs[0]!.account_id)[0]?.key ?? "Near", amount: "1" }])}>
          Add a fixed amount
        </Button>
      </section>

      <Field label="Rounding leftovers go to" hint="Otherwise a few units of each asset stay in the plan.">
        {(p) => (
          <select {...p} className={inputClass} value={remainder} onChange={(e) => setRemainder(e.target.value)}>
            <option value="">Nobody (stay in the plan)</option>
            {heirs.map((h) => (
              <option key={h.account_id} value={h.account_id}>
                {shortName(h.account_id)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <section className="flex flex-col gap-3">
        <h3 className="font-semibold">If a heir doesn&apos;t claim</h3>
        <Field label="Claim window (days)" tip="claimWindow" hint="How long each person has to claim before their share can be moved on.">
          {(p) => <input {...p} className={`${inputClass} sm:w-40`} inputMode="decimal" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />}
        </Field>
        {heirs.map((h) => (
          <div key={h.account_id}>{recipientFields(alts[h.account_id] ?? emptyRecipient, (d) => setAlts({ ...alts, [h.account_id]: d }), `Alternate for ${shortName(h.account_id)}`)}</div>
        ))}
        {recipientFields(fallback, setFallback, "Fallback for anything left")}
        <span className="text-xs leading-relaxed text-muted">
          Alternates and the fallback must not be you, a heir or a guardian. Each receives only on chains where they have a destination; a share they can&apos;t receive stays where it is.
        </span>
      </section>

      {error && <Notice tone="error">{error}</Notice>}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap gap-2 bg-paper px-1 pt-2">
        <Button variant="primary" loading={busy} onClick={save}>
          Save rules
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {initial && (
          <Button
            variant="danger"
            icon={Trash2}
            className="sm:ml-auto"
            disabled={busy}
            onClick={async () => {
              if (await confirm({ title: "Remove all release rules?", body: "Everything will be split by share only, and unclaimed shares will wait for their heir.", tone: "danger", confirmLabel: "Remove rules" })) onSave(null);
            }}
          >
            Remove all
          </Button>
        )}
      </div>
      <span className="text-xs text-muted">
        Saving attaches 0.01 NEAR for storage; what isn&apos;t used is refunded. <Term k="claimWindow">About claim windows</Term>
      </span>
    </div>
  );
}
