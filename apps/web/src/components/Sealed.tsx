"use client";
// D33 private (sealed) heirs on the plan page: reveal progress and the
// "Reveal my share" card, the owner's records, backup and rules.
import { CloudDownload, CloudOff, CloudUpload, Download, EyeOff, FileUp, KeyRound, LockKeyhole, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isMissingMethod, view } from "@/lib/contract";
import { backupRecords, clearRecordBackup, fetchRecords, openSession } from "@/lib/notify";
import { duration, shortName, when } from "@/lib/plan";
import { commitment, downloadJson, localRecords, matching, parseRecordFile, recordFile, saveLocalRecords, type HeirRecord, type PrivateView, type Unrevealed } from "@/lib/sealed";
import { humanError } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { PlanView, ReleaseRules } from "@/lib/types";
import { Countdown, Field, Segmented } from "./interactive";
import { HeirList } from "./PlanParts";
import { useTx } from "./tx";
import { Button, Card, Notice, SectionTitle, cx, inputClass } from "./ui";

export interface Sealed {
  /** undefined: loading; null: a public plan (or an older contract). */
  view: PrivateView | null | undefined;
  reload: () => Promise<void>;
}

export function useSealed(owner: string, key?: unknown): Sealed {
  const [v, setV] = useState<PrivateView | null | undefined>(undefined);
  const reload = useCallback(async () => {
    try {
      setV(await view<PrivateView | null>("get_private_heirs", { owner }));
    } catch (e) {
      setV(isMissingMethod(e) ? null : (x) => x ?? null);
    }
  }, [owner]);
  useEffect(() => void reload(), [reload, key]);
  return { view: v, reload };
}

/** The heir list, or (for a sealed plan) how many private heirs there are. */
export function Heirs({ view: v, sealed, me }: { view: PlanView; sealed: Sealed; me?: string | null }) {
  if (!v.plan.policy.heirs.length && sealed.view) return <SealedHeirsCard planView={v} sealed={sealed.view} />;
  return <HeirList view={v} me={me} />;
}

/** Who inherits isn't public: shown in place of the heir list. */
export function SealedHeirsCard({ planView, sealed }: { planView: PlanView; sealed: PrivateView }) {
  const n = sealed.commitments.length;
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={EyeOff} title={`${n} private heir${n === 1 ? "" : "s"}`} sub={`Who inherits, how much and where stay off the public record until ${shortName(planView.plan.owner)} is overdue.`} />
      {sealed.revealed.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {sealed.revealed.map((r) => (
            <li key={r.index} className="flex items-center justify-between gap-2 rounded-row bg-subtle px-3 py-2 text-sm">
              <span>
                Heir {r.index + 1}: {shortName(r.account_id)}
              </span>
              <span className="tabular text-muted">{r.share_bps / 100}%</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Reveal progress, and a heir's (or anyone's) "Reveal my share". */
export function RevealCard({ planView, sealed, me, onRevealed }: { planView: PlanView; sealed: Sealed; me: string | null; onRevealed?: () => unknown }) {
  const s = sealed.view;
  const owner = planView.plan.owner;
  const { session } = useSession();
  const { busy, act } = useTx(async () => {
    await sealed.reload();
    await onRevealed?.();
  });
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  if (!s) return null;
  const open = planView.now_ms >= planView.overdue_at_ms && !planView.plan.proposal;
  const n = s.commitments.length;
  const all = s.revealed.length === n;
  if (!open && !s.revealed.length) return null;

  async function reveal(raw: string) {
    setErr(null);
    const f = parseRecordFile(raw);
    if (!f) return setErr("That isn't a Behest recovery record.");
    if (f.owner && f.owner !== owner) return setErr(`That record belongs to ${f.owner}'s plan, not this one.`);
    if (!s!.commitments.includes(await commitment(owner, f.record))) return setErr("That record doesn't match this plan. It may be from an older version of the plan.");
    if (s!.revealed.some((r) => r.account_id === f.record.account_id)) return setErr(`${shortName(f.record.account_id)} is already revealed.`);
    if (!session) return setErr("Sign in first (any account works; Behest pays the fee).");
    if (await act(`Reveal ${shortName(f.record.account_id)}`, "reveal_heir", { owner, record: f.record }, { done: `Revealed. ${shortName(f.record.account_id)} is now a heir of this plan's release.` })) setText("");
  }
  async function fromBehest() {
    if (!session) return setErr("Sign in as the heir first.");
    setFetching(true);
    setErr(null);
    try {
      const r = await fetchRecords(await openSession(session), owner);
      const rec = r.records.find((x) => x.account_id === session.accountId) ?? r.records[0];
      if (!rec) throw new Error("Behest has no record for you.");
      const { backed_up_ms: _, ...record } = rec;
      await reveal(JSON.stringify(record));
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setFetching(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={LockKeyhole}
        title={all ? "Every private heir is revealed" : open ? "Private heirs: reveal to receive" : "Private heirs"}
        sub={
          all
            ? "Guardians can now propose the release."
            : open
              ? `${shortName(owner)} keeps the heirs private. Each heir (or anyone holding their recovery record) reveals it here. A release can start once ${n === 2 ? "both are" : `all ${n} are`} revealed, or after the reveal window.`
              : `${s.revealed.length} of ${n} revealed.`
        }
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded-full bg-subtle px-3 py-1 font-semibold tabular">
          {s.revealed.length} of {n} revealed
        </span>
        {!all && open && (s.reveal_deadline_ms > planView.now_ms ? <Countdown to={s.reveal_deadline_ms} now={planView.now_ms} prefix="window ends " /> : <span className="text-muted">Window over: a release can start with the heirs revealed so far ({s.unrevealed === "Fallback" ? "the rest goes to the fallback" : "they share the rest"}).</span>)}
      </div>
      {open && !all && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Field label="Your recovery record" hint="Paste the text from your packet or record file, or upload the file." error={err}>
            {(c) => <textarea {...c} rows={3} className={cx(inputClass, "font-mono text-[12px]")} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder='{"behest_record":1,…}' />}
          </Field>
          <input
            ref={file}
            type="file"
            accept="application/json,.json,.txt"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await reveal(await f.text());
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={KeyRound} disabled={!text.trim() || !!busy} loading={!!busy} onClick={() => void reveal(text)}>
              Reveal my share
            </Button>
            <Button variant="outline" icon={FileUp} disabled={!!busy} onClick={() => file.current?.click()}>
              Upload record file
            </Button>
            {me && (
              <Button variant="subtle" icon={CloudDownload} disabled={!!busy || fetching} loading={fetching} onClick={() => void fromBehest()}>
                Get mine from Behest
              </Button>
            )}
          </div>
          <p className="text-sm text-muted">Revealing is public and final for this round: funds can only go to the addresses inside the record. If {shortName(owner)} checks in again, the plan is hidden again.</p>
        </div>
      )}
    </Card>
  );
}

/** The owner's view: records on this device, Behest's backup, and the unrevealed rule. */
export function SealedOwnerCard({ planView, sealed, rules, editable, onChanged }: { planView: PlanView; sealed: Sealed; rules: ReleaseRules | null | undefined; editable: boolean; onChanged?: () => unknown }) {
  const s = sealed.view;
  const owner = planView.plan.owner;
  const { session } = useSession();
  const { busy, run, act } = useTx(async () => {
    await sealed.reload();
    await onChanged?.();
  });
  const [mine, setMine] = useState<HeirRecord[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    if (s) setMine(await matching(owner, localRecords(owner), s.commitments));
  }, [owner, s]);
  useEffect(() => void refresh(), [refresh]);
  if (!s) return null;
  const n = s.commitments.length;

  async function importText(texts: string[]) {
    setErr(null);
    const recs: HeirRecord[] = [];
    for (const t of texts) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        parsed = null;
      }
      for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
        const f = parseRecordFile(JSON.stringify(one));
        if (f) recs.push(f.record);
      }
    }
    const ok = await matching(owner, [...mine, ...recs], s!.commitments);
    const unique = [...new Map(ok.map((r) => [r.account_id, r])).values()];
    if (unique.length === mine.length) return setErr("None of those records match this plan.");
    saveLocalRecords(owner, unique);
    setMine(unique);
  }
  const fromBehest = () =>
    run(
      "Restore records from Behest",
      async () => {
        if (!session) throw new Error("Sign in first.");
        const r = await fetchRecords(await openSession(session), owner);
        await importText([JSON.stringify(r.records.map(({ backed_up_ms: _, ...x }) => x))]);
      },
      { done: "Records restored to this browser." },
    );
  const backup = () =>
    run(
      "Back up records to Behest",
      async () => {
        if (!session) throw new Error("Sign in first.");
        await backupRecords(session, mine);
      },
      { done: "Behest keeps an encrypted copy. Each heir can get theirs once you're overdue." },
    );
  const unbackup = () =>
    run(
      "Remove Behest's copy",
      async () => {
        if (!session) throw new Error("Sign in first.");
        await clearRecordBackup(session);
      },
      { done: "Behest's copy is deleted." },
    );
  const setRule = (u: Unrevealed) =>
    act("Change what happens to unrevealed shares", "set_private_plan", { plan: planView.plan.policy, sealed: { commitments: s.commitments, reveal_window_ms: s.reveal_window_ms, unrevealed: u } }, { deposit: 10n ** 22n, done: "Saved." });

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={EyeOff} title="Private heirs" sub={`${n} heir${n === 1 ? "" : "s"} sealed. Reveals open when you're overdue; a release waits up to ${duration(s.reveal_window_ms)} for them.`} />
      {s.revealed.length > 0 && (
        <Notice tone="warn" title={`${s.revealed.length} of ${n} heirs revealed`}>
          You&apos;re overdue and heirs have started revealing. Check in to hide them again.
        </Notice>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Recovery records in this browser: {mine.length} of {n}</span>
        {mine.length < n && <p className="text-sm text-muted">Restore them from your record files or Behest&apos;s copy to print packets or edit heirs.</p>}
        <div className="flex flex-wrap gap-2">
          {mine.length > 0 && (
            <Button size="sm" variant="outline" icon={Download} onClick={() => downloadJson(`behest-records-${owner}.json`, mine.map((r) => recordFile(owner, r)))}>
              Download records
            </Button>
          )}
          <Button size="sm" variant="subtle" icon={Upload} onClick={() => file.current?.click()}>
            Restore from files
          </Button>
          <Button size="sm" variant="subtle" icon={CloudDownload} disabled={!!busy} onClick={() => void fromBehest()}>
            Restore from Behest
          </Button>
        </div>
        <input
          ref={file}
          type="file"
          multiple
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const fs = [...(e.target.files ?? [])];
            await importText(await Promise.all(fs.map((f) => f.text())));
            e.target.value = "";
          }}
        />
        {err && <p className="text-sm text-error">{err}</p>}
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <span className="text-sm font-semibold">Behest backup</span>
        <p className="text-sm text-muted">Optional. Behest stores the records encrypted and gives each heir theirs only once you&apos;re overdue, so a lost record isn&apos;t a lost share. Behest itself could read them.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={CloudUpload} disabled={mine.length < n || !!busy} onClick={() => void backup()}>
            Back up to Behest
          </Button>
          <Button size="sm" variant="subtle" icon={CloudOff} disabled={!!busy} onClick={() => void unbackup()}>
            Remove Behest&apos;s copy
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <span className="text-sm font-semibold">If a heir never reveals</span>
        <Segmented
          label="If a heir never reveals"
          value={s.unrevealed}
          onChange={(v) => editable && v !== s.unrevealed && void setRule(v)}
          options={[{ value: "Redistribute", label: "Split among the others" }, ...(rules?.fallback ? [{ value: "Fallback" as const, label: `To ${shortName(rules.fallback.account_id)}` }] : [])]}
        />
        {!rules?.fallback && <p className="text-sm text-muted">Add a fallback recipient under release rules to send unrevealed shares there.</p>}
        {s.revealed.length === 0 && planView.now_ms < planView.overdue_at_ms && <p className="text-sm text-muted">Reveals open {when(planView.overdue_at_ms)} if you don&apos;t check in.</p>}
      </div>
    </Card>
  );
}
