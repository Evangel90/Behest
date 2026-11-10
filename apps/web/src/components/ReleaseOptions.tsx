"use client";
// Release mode and delay signers (contract D18, D19). Everyone sees them in
// plain words; the owner edits them while no release is open; delay signers
// request or approve an extension while an approved release is waiting.
import { Hourglass, Pencil, Plus, Settings2, Trash2, Zap, Hand, Shuffle, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { view as viewCall } from "@/lib/contract";
import { describeOptions, duration, relative, shortName, when } from "@/lib/plan";
import type { ExtensionState, ModeOverride, PlanView, ReleaseOptions } from "@/lib/types";
import { useConfirm } from "./feedback";
import { Dialog, Disclosure, Field, Term } from "./interactive";
import type { Act } from "./tx";
import { Button, IconButton, Notice, Skeleton, cx, inputClass } from "./ui";

const MIN = 60_000;

export interface OptionsState {
  options: ReleaseOptions | null | undefined;
  ext: ExtensionState | null;
  reload: () => Promise<void>;
}

export function useOptions(owner: string, proposalId?: number, waitingEnds?: number | null): OptionsState {
  const [options, setOptions] = useState<ReleaseOptions | null | undefined>(undefined);
  const [ext, setExt] = useState<ExtensionState | null>(null);
  const load = useCallback(async () => {
    const [o, x] = await Promise.all([
      viewCall<ReleaseOptions | null>("get_release_options", { owner }).catch(() => null),
      viewCall<ExtensionState | null>("get_extension", { owner }).catch(() => null),
    ]);
    setOptions(o);
    setExt(x);
  }, [owner]);
  // reload when the proposal or its end time changes (an extension applied)
  useEffect(() => void load(), [load, proposalId, waitingEnds]);
  return { options, ext, reload: load };
}

const MODE_ICON: Record<ReleaseOptions["mode"], LucideIcon> = { Claim: Hand, Automatic: Zap, Hybrid: Shuffle };

export function OptionsCard({ view, now, me, editable, act, busy, state, defaultOpen, controls = true }: { view: PlanView; now: number; me: string | null; editable: boolean; act: Act; busy: boolean; state: OptionsState; defaultOpen?: boolean; controls?: boolean }) {
  const prop = view.plan.proposal;
  const { options, ext, reload } = state;
  const [editing, setEditing] = useState(false);
  const run: Act = async (...a) => {
    const ok = await act(...a);
    await reload();
    return ok;
  };
  const lines = options === undefined ? [] : describeOptions(options);
  const isSigner = !!me && !!options?.delay_signers.includes(me);
  const waiting = view.status === "Waiting" && prop?.waiting_ends_at_ms != null && now < prop.waiting_ends_at_ms;
  const mode = options?.mode ?? "Claim";
  const M = MODE_ICON[mode];

  return (
    <Disclosure
      id="options"
      icon={Settings2}
      title="Release mode & delay signers"
      sub={options === undefined ? "Reading…" : `${mode} mode · ${options?.delay_signers.length ? `${options.delay_signers.length} delay signer${options.delay_signers.length === 1 ? "" : "s"}` : "no delay signers"}`}
      defaultOpen={defaultOpen}
      aside={editable ? <IconButton icon={Pencil} label="Edit release mode and delay signers" disabled={busy} onClick={() => setEditing(true)} /> : undefined}
    >
      {options === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-row bg-subtle p-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-card">
              <M className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="font-semibold">
                <Term k="releaseMode">{mode} mode</Term>
              </span>
              <span className="text-sm text-muted">{lines[0]}</span>
            </span>
          </div>
          {lines.length > 1 && (
            <ul className="flex flex-col gap-2">
              {lines.slice(1).map((l) => (
                <li key={l} className="flex gap-2.5 text-[15px] leading-relaxed">
                  <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-signal" />
                  {l}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {options && options.delay_signers.length > 0 && (
        <span className="text-sm text-muted">
          <Term k="delaySigner">Delay signers</Term>: {options.delay_signers.map(shortName).join(", ")}
          {options.delay_signers.some((d) => view.plan.policy.guardians.includes(d)) && " (some are also guardians)"}
        </span>
      )}
      <ExtensionStatus view={view} now={now} state={state} />
      {controls && waiting && isSigner && options && <ExtensionControls view={view} now={now} me={me!} options={options} ext={ext} busy={busy} act={run} />}
      {editable && (
        <Button variant="outline" size="sm" icon={Pencil} className="self-start" disabled={busy} onClick={() => setEditing(true)}>
          Change mode or delay signers
        </Button>
      )}
      <Dialog open={editing} onClose={() => setEditing(false)} title="Release mode & delay signers" description="How transfers start once the waiting period ends, and who may lengthen it." size="lg">
        {editing && options !== undefined && (
          <OptionsEditor
            view={view}
            initial={options}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={async (o) => {
              const ok = await run(o ? "Save release options" : "Clear release options", "set_release_options", { options: o }, o ? { deposit: 10n ** 22n } : {});
              if (ok) setEditing(false);
            }}
          />
        )}
      </Dialog>
    </Disclosure>
  );
}

/** Extension facts while a release waits: how much has been added, and any pending request. */
export function ExtensionStatus({ view, now, state }: { view: PlanView; now: number; state: OptionsState }) {
  const prop = view.plan.proposal;
  const { options, ext } = state;
  const waiting = view.status === "Waiting" && prop?.waiting_ends_at_ms != null && now < prop.waiting_ends_at_ms;
  return (
    <>
      {ext && ext.total_ms > 0 && prop?.waiting_ends_at_ms && (
        <Notice tone="info" title={`Waiting period extended ${ext.count} time${ext.count === 1 ? "" : "s"}`}>
          {duration(ext.total_ms)} in total. The owner can still cancel until {when(prop.waiting_ends_at_ms)}.
        </Notice>
      )}
      {waiting && ext?.pending && (
        <Notice tone="warn" title={`Extension of ${duration(ext.pending.extension_ms)} requested`}>
          {ext.pending.reason ? `Reason: ${ext.pending.reason}. ` : ""}
          {ext.pending.votes.length} of {options?.delay_quorum} delay signers agree.
        </Notice>
      )}
    </>
  );
}

/** Delay signer: request an extension, or agree to a pending one. */
export function ExtensionControls({ view, now, me, options, ext, busy, act }: { view: PlanView; now: number; me: string; options: ReleaseOptions; ext: ExtensionState | null; busy: boolean; act: Act }) {
  const confirm = useConfirm();
  const prop = view.plan.proposal!;
  const left = options.max_total_extension_ms - (ext?.total_ms ?? 0);
  const max = Math.min(options.max_extension_ms, left);
  const maxMin = Math.max(1, Math.floor(max / MIN));
  const [minutes, setMinutes] = useState(String(maxMin));
  const [reason, setReason] = useState("");
  const pending = ext?.pending;
  if (pending) {
    const voted = pending.votes.includes(me);
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-row border border-line p-4">
        <Button
          variant="primary"
          icon={Hourglass}
          loading={busy}
          disabled={voted}
          onClick={async () => {
            if (await confirm({ title: `Extend by ${duration(pending.extension_ms)}?`, body: "Heirs will wait longer before they can receive. The owner can still cancel during that time.", confirmLabel: "Agree" }))
              await act("Agree to extension", "approve_extension", { owner: view.plan.owner, proposal_id: prop.id });
          }}
        >
          {voted ? "You agreed" : `Agree: extend by ${duration(pending.extension_ms)}`}
        </Button>
        <span className="text-sm text-muted">Waiting period ends {relative(prop.waiting_ends_at_ms!, now)} unless extended.</span>
      </div>
    );
  }
  if (max <= 0) return <p className="rounded-row bg-subtle p-4 text-sm text-muted">The total extension cap is used up.</p>;
  const n = Number(minutes);
  const invalid = !(n > 0) || n * MIN > max;
  return (
    <div className="flex flex-col gap-4 rounded-row border border-line p-4">
      <span className="font-semibold">Ask for more time</span>
      <Field label="Extend by" hint={`Up to ${duration(maxMin * MIN)} this time.`} error={minutes && invalid ? `Between 1 and ${maxMin} minutes.` : null}>
        {(p) => (
          <div className="flex items-center gap-3">
            <input {...p} type="range" min={1} max={maxMin} step={1} value={Math.min(maxMin, Math.max(1, n || 1))} onChange={(e) => setMinutes(e.target.value)} className="h-11 min-w-0 flex-1 accent-[var(--primary)]" aria-valuetext={duration(n * MIN)} />
            <span className="tabular w-28 shrink-0 text-right text-sm font-semibold">{duration((n || 0) * MIN)}</span>
          </div>
        )}
      </Field>
      <Field label="Reason code" optional hint="Public and stored on-chain. Don't include personal details.">
        {(p) => <input {...p} className={inputClass} maxLength={64} value={reason} placeholder="e.g. owner-unreachable-check" onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <Button
        variant="primary"
        icon={Hourglass}
        className="self-start"
        loading={busy}
        disabled={invalid}
        onClick={async () => {
          if (
            await confirm({
              title: `Request ${duration(n * MIN)} more?`,
              body: `It applies once ${options.delay_quorum} delay signer${options.delay_quorum === 1 ? "" : "s"} agree. You can't approve, cancel or move anything.`,
              rows: reason.trim() ? [["Reason", reason.trim()]] : undefined,
              confirmLabel: "Request extension",
            })
          )
            await act("Request extension", "request_extension", { owner: view.plan.owner, proposal_id: prop.id, extension_ms: Math.round(n * MIN), reason: reason.trim() || null });
        }}
      >
        Request extension
      </Button>
    </div>
  );
}

const MODES = [
  ["Claim", "Each heir claims their share.", Hand],
  ["Automatic", "Transfers start by themselves when the waiting period ends.", Zap],
  ["Hybrid", "Heirs can claim first; after a grace period, transfers start by themselves.", Shuffle],
] as const;

function OptionsEditor({ view, initial, busy, onCancel, onSave }: { view: PlanView; initial: ReleaseOptions | null; busy: boolean; onCancel: () => void; onSave: (o: ReleaseOptions | null) => void }) {
  const confirm = useConfirm();
  const [mode, setMode] = useState<ReleaseOptions["mode"]>(initial?.mode ?? "Claim");
  const [grace, setGrace] = useState(initial?.hybrid_grace_ms ? String(initial.hybrid_grace_ms / MIN) : "1440");
  const [signers, setSigners] = useState((initial?.delay_signers ?? []).join(", "));
  const [quorum, setQuorum] = useState(String(initial?.delay_quorum || 1));
  const [maxExt, setMaxExt] = useState(initial?.max_extension_ms ? String(initial.max_extension_ms / MIN) : "1440");
  const [maxTotal, setMaxTotal] = useState(initial?.max_total_extension_ms ? String(initial.max_total_extension_ms / MIN) : "10080");
  const [overrides, setOverrides] = useState<(Omit<ModeOverride, "hybrid_grace_ms"> & { grace: string })[]>(
    (initial?.overrides ?? []).map((o) => ({ heir: o.heir, assets: o.assets, mode: o.mode, grace: o.hybrid_grace_ms ? String(o.hybrid_grace_ms / MIN) : "1440" })),
  );
  const heirs = view.plan.policy.heirs.map((h) => h.account_id);
  const [error, setError] = useState<string | null>(null);
  const list = signers
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  function save() {
    setError(null);
    if (list.some((s) => s === view.plan.owner || heirs.includes(s))) return setError("Delay signers can't be you or a heir.");
    const q = Number(quorum);
    if (list.length && !(q >= 1 && q <= list.length)) return setError(`Signers needed must be between 1 and ${list.length}.`);
    onSave({
      mode,
      hybrid_grace_ms: mode === "Hybrid" ? Math.round(Number(grace) * MIN) : 0,
      delay_signers: list,
      delay_quorum: list.length ? q : 0,
      max_extension_ms: list.length ? Math.round(Number(maxExt) * MIN) : 0,
      max_total_extension_ms: list.length ? Math.round(Number(maxTotal) * MIN) : 0,
      overrides: overrides.map((o) => ({ heir: o.heir, assets: o.assets, mode: o.mode, hybrid_grace_ms: o.mode === "Hybrid" ? Math.round(Number(o.grace) * MIN) : 0 })),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 font-semibold">How transfers start</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map(([m, text, I]) => (
            <label key={m} className={cx("flex cursor-pointer flex-col gap-2 rounded-row border p-4 transition-colors", mode === m ? "border-signal bg-s-approved" : "border-line hover:bg-subtle")}>
              <span className="flex items-center justify-between">
                <I aria-hidden className="size-5" />
                <input type="radio" name="release-mode" className="size-5 accent-[var(--primary)]" checked={mode === m} onChange={() => setMode(m)} />
              </span>
              <span className="font-semibold">{m}</span>
              <span className="text-sm text-muted">{text}</span>
            </label>
          ))}
        </div>
        {mode === "Hybrid" && (
          <Field label="Grace period (minutes)" hint={`${duration(Number(grace) * MIN || 0)} for heirs to claim before it's automatic.`}>
            {(p) => <input {...p} className={`${inputClass} sm:w-40`} inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />}
          </Field>
        )}
      </fieldset>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-semibold">Exceptions for a heir or asset group</h3>
          <span className="text-sm text-muted">Checked top to bottom; the first that matches a transfer decides how it starts. Everything else uses the mode above.</span>
        </div>
        {overrides.map((o, i) => {
          const set = (x: Partial<(typeof overrides)[number]>) => setOverrides(overrides.map((y, j) => (j === i ? { ...y, ...x } : y)));
          return (
            <div key={i} className="grid animate-fade-up grid-cols-2 items-end gap-2 rounded-row border border-line p-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
              <Field label="Heir">
                {(p) => (
                  <select {...p} className={inputClass} value={o.heir ?? ""} onChange={(e) => set({ heir: e.target.value || null })}>
                    <option value="">Every heir</option>
                    {heirs.map((h) => (
                      <option key={h} value={h}>
                        {shortName(h)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Assets">
                {(p) => (
                  <select {...p} className={inputClass} value={o.assets} onChange={(e) => set({ assets: e.target.value as ModeOverride["assets"] })}>
                    <option value="All">All</option>
                    <option value="Near">NEAR and NEAR tokens</option>
                    <option value="Ethereum">ETH and Ethereum tokens</option>
                    <option value="Bitcoin">BTC</option>
                  </select>
                )}
              </Field>
              <Field label="Mode">
                {(p) => (
                  <select {...p} className={inputClass} value={o.mode} onChange={(e) => set({ mode: e.target.value as ModeOverride["mode"] })}>
                    <option value="Claim">Claim</option>
                    <option value="Automatic">Automatic</option>
                    <option value="Hybrid">Hybrid</option>
                  </select>
                )}
              </Field>
              {o.mode === "Hybrid" ? <Field label="Grace (min)">{(p) => <input {...p} className={`${inputClass} sm:w-24`} inputMode="numeric" value={o.grace} onChange={(e) => set({ grace: e.target.value })} />}</Field> : <span className="hidden sm:block" />}
              <IconButton icon={Trash2} label={`Remove exception ${i + 1}`} className="justify-self-end" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        <Button variant="outline" size="sm" icon={Plus} className="self-start" onClick={() => setOverrides([...overrides, { heir: heirs[0] ?? null, assets: "All", mode: "Automatic", grace: "1440" }])}>
          Add an exception
        </Button>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-semibold">
            <Term k="delaySigner">Delay signers</Term> <span className="font-medium text-muted">(optional)</span>
          </h3>
          <span className="text-sm text-muted">They can only lengthen an approved release&apos;s waiting period, never approve or move funds. Guardians may be included.</span>
        </div>
        <Field label="Accounts, comma separated">{(p) => <input {...p} className={inputClass} value={signers} placeholder="ife.testnet, kola.testnet" spellCheck={false} onChange={(e) => setSigners(e.target.value)} />}</Field>
        {list.length > 0 && (
          <div className="grid animate-fade-up gap-2 sm:grid-cols-3">
            <Field label="Signers needed">{(p) => <input {...p} className={inputClass} inputMode="numeric" value={quorum} onChange={(e) => setQuorum(e.target.value)} />}</Field>
            <Field label="Max per extension (min)" hint={duration(Number(maxExt) * MIN || 0)}>
              {(p) => <input {...p} className={inputClass} inputMode="numeric" value={maxExt} onChange={(e) => setMaxExt(e.target.value)} />}
            </Field>
            <Field label="Max in total (min)" hint={duration(Number(maxTotal) * MIN || 0)}>
              {(p) => <input {...p} className={inputClass} inputMode="numeric" value={maxTotal} onChange={(e) => setMaxTotal(e.target.value)} />}
            </Field>
          </div>
        )}
      </section>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap gap-2 bg-paper px-1 pt-2">
        <Button variant="primary" loading={busy} onClick={save}>
          Save
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {initial && (
          <Button
            variant="danger"
            className="sm:ml-auto"
            disabled={busy}
            onClick={async () => {
              if (await confirm({ title: "Reset to defaults?", body: "Heirs will claim their own shares, and delay signers are removed.", tone: "danger", confirmLabel: "Reset" })) onSave(null);
            }}
          >
            Reset to defaults
          </Button>
        )}
      </div>
      <span className="text-xs text-muted">Can&apos;t change while a release is open. Saving attaches 0.01 NEAR for storage; what isn&apos;t used is refunded.</span>
    </div>
  );
}
