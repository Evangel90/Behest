"use client";
// Release mode and delay signers (contract D18, D19). Everyone sees them in
// plain words; the owner edits them while no release is open; delay signers
// request or approve an extension while an approved release is waiting.
import { useCallback, useEffect, useState } from "react";
import { view as viewCall } from "@/lib/contract";
import { describeOptions, duration, relative, shortName } from "@/lib/plan";
import type { ExtensionState, PlanView, ReleaseOptions } from "@/lib/types";
import { Bracket, Button, Card, Field, Notice, inputClass } from "./ui";

type Act = (label: string, method: string, args: Record<string, unknown>, deposit?: bigint) => unknown;
const MIN = 60_000;

export function useOptions(owner: string, proposalId?: number, waitingEnds?: number | null) {
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

export function OptionsCard({ view, now, me, editable, act, busy }: { view: PlanView; now: number; me: string | null; editable: boolean; act: Act; busy: boolean }) {
  const prop = view.plan.proposal;
  const { options, ext, reload } = useOptions(view.plan.owner, prop?.id, prop?.waiting_ends_at_ms);
  const [editing, setEditing] = useState(false);
  const run = async (...a: Parameters<Act>) => {
    await act(...a);
    await reload();
  };
  const lines = options === undefined ? [] : describeOptions(options);
  const isSigner = !!me && !!options?.delay_signers.includes(me);
  const waiting = view.status === "Waiting" && prop?.waiting_ends_at_ms != null && now < prop.waiting_ends_at_ms;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Bracket>Release mode · delay signers</Bracket>
        {editable && !editing && (
          <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {options === undefined ? (
        <span className="text-sm text-muted">Reading…</span>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {options && options.delay_signers.length > 0 && (
        <span className="text-sm text-muted">
          Delay signers: {options.delay_signers.map(shortName).join(", ")}
          {options.delay_signers.some((d) => view.plan.policy.guardians.includes(d)) && " (some are also guardians)"}
        </span>
      )}
      {ext && ext.total_ms > 0 && (
        <Notice>
          Waiting period extended {ext.count} time{ext.count === 1 ? "" : "s"}, {duration(ext.total_ms)} in total. The owner can still cancel until {new Date(prop!.waiting_ends_at_ms!).toLocaleString()}.
        </Notice>
      )}
      {waiting && ext?.pending && (
        <span className="text-sm">
          Extension of {duration(ext.pending.extension_ms)} requested{ext.pending.reason ? ` (${ext.pending.reason})` : ""}: {ext.pending.votes.length} of {options?.delay_quorum} signers agree.
        </span>
      )}
      {waiting && isSigner && options && <ExtensionControls view={view} now={now} me={me!} options={options} ext={ext} busy={busy} act={run} />}
      {editing && options !== undefined && (
        <OptionsEditor
          view={view}
          initial={options}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(o) => {
            setEditing(false);
            void run(o ? "Save release options" : "Clear release options", "set_release_options", { options: o }, o ? 10n ** 22n : undefined);
          }}
        />
      )}
    </Card>
  );
}

function ExtensionControls({ view, now, me, options, ext, busy, act }: { view: PlanView; now: number; me: string; options: ReleaseOptions; ext: ExtensionState | null; busy: boolean; act: Act }) {
  const prop = view.plan.proposal!;
  const left = options.max_total_extension_ms - (ext?.total_ms ?? 0);
  const max = Math.min(options.max_extension_ms, left);
  const [minutes, setMinutes] = useState(String(Math.max(1, Math.floor(max / MIN))));
  const [reason, setReason] = useState("");
  const pending = ext?.pending;
  if (pending) {
    const voted = pending.votes.includes(me);
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button disabled={busy || voted} onClick={() => act("Agree to extension", "approve_extension", { owner: view.plan.owner, proposal_id: prop.id })}>
          {voted ? "You agreed" : `Agree: extend by ${duration(pending.extension_ms)}`}
        </Button>
        <span className="text-xs text-muted">Waiting period ends {relative(prop.waiting_ends_at_ms!, now)} unless extended.</span>
      </div>
    );
  }
  if (max <= 0) return <span className="border-t border-line pt-3 text-sm text-muted">The total extension cap is used up.</span>;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="font-semibold">You're a delay signer</span>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`Extend by (minutes, max ${Math.floor(max / MIN)})`}>
          <input className={`${inputClass} w-32`} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
        <Field label="Reason code (optional, public)">
          <input className={`${inputClass} w-48`} maxLength={64} value={reason} placeholder="e.g. owner-unreachable-check" onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button
          disabled={busy || !(Number(minutes) > 0) || Number(minutes) * MIN > max}
          onClick={() => act("Request extension", "request_extension", { owner: view.plan.owner, proposal_id: prop.id, extension_ms: Math.round(Number(minutes) * MIN), reason: reason.trim() || null })}
        >
          Request extension
        </Button>
      </div>
      <span className="text-xs text-muted">Don't put personal details in the reason; it's stored on-chain. It applies once {options.delay_quorum} signers agree.</span>
    </div>
  );
}

function OptionsEditor({ view, initial, busy, onCancel, onSave }: { view: PlanView; initial: ReleaseOptions | null; busy: boolean; onCancel: () => void; onSave: (o: ReleaseOptions | null) => void }) {
  const [mode, setMode] = useState<ReleaseOptions["mode"]>(initial?.mode ?? "Claim");
  const [grace, setGrace] = useState(initial?.hybrid_grace_ms ? String(initial.hybrid_grace_ms / MIN) : "1440");
  const [signers, setSigners] = useState((initial?.delay_signers ?? []).join(", "));
  const [quorum, setQuorum] = useState(String(initial?.delay_quorum || 1));
  const [maxExt, setMaxExt] = useState(initial?.max_extension_ms ? String(initial.max_extension_ms / MIN) : "1440");
  const [maxTotal, setMaxTotal] = useState(initial?.max_total_extension_ms ? String(initial.max_total_extension_ms / MIN) : "10080");
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    const list = signers.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const heirs = view.plan.policy.heirs.map((h) => h.account_id);
    if (list.some((s) => s === view.plan.owner || heirs.includes(s))) return setError("Delay signers can't be you or a heir.");
    const q = Number(quorum);
    if (list.length && !(q >= 1 && q <= list.length)) return setError(`Quorum must be between 1 and ${list.length}.`);
    onSave({
      mode,
      hybrid_grace_ms: mode === "Hybrid" ? Math.round(Number(grace) * MIN) : 0,
      delay_signers: list,
      delay_quorum: list.length ? q : 0,
      max_extension_ms: list.length ? Math.round(Number(maxExt) * MIN) : 0,
      max_total_extension_ms: list.length ? Math.round(Number(maxTotal) * MIN) : 0,
    });
  }

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">How transfers start</legend>
        {(
          [
            ["Claim", "Each heir claims their share."],
            ["Automatic", "Transfers start by themselves when the waiting period ends."],
            ["Hybrid", "Heirs can claim first; after a grace period, transfers start by themselves."],
          ] as const
        ).map(([m, text]) => (
          <label key={m} className="flex min-h-11 items-center gap-3">
            <input type="radio" name="release-mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <strong>{m}</strong> · {text}
            </span>
          </label>
        ))}
        {mode === "Hybrid" && (
          <Field label="Grace period (minutes)">
            <input className={`${inputClass} w-32`} inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
          </Field>
        )}
      </fieldset>
      <div className="flex flex-col gap-2">
        <span className="font-semibold">Delay signers (optional)</span>
        <Field label="Accounts, comma separated" hint="They can only lengthen an approved release's waiting period, never approve or move funds. Guardians may be included.">
          <input className={inputClass} value={signers} placeholder="ife.testnet, kola.testnet" onChange={(e) => setSigners(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Field label="Signers needed">
            <input className={`${inputClass} w-24`} inputMode="numeric" value={quorum} onChange={(e) => setQuorum(e.target.value)} />
          </Field>
          <Field label="Max per extension (min)">
            <input className={`${inputClass} w-32`} inputMode="numeric" value={maxExt} onChange={(e) => setMaxExt(e.target.value)} />
          </Field>
          <Field label="Max in total (min)">
            <input className={`${inputClass} w-32`} inputMode="numeric" value={maxTotal} onChange={(e) => setMaxTotal(e.target.value)} />
          </Field>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={save}>
          Save options
        </Button>
        {initial && (
          <Button variant="outline" disabled={busy} onClick={() => onSave(null)}>
            Reset to defaults
          </Button>
        )}
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="text-xs text-muted">Can't change while a release is open. Saving attaches 0.01 NEAR for storage; what isn't used is refunded.</span>
    </div>
  );
}
