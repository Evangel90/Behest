"use client";
// D28 edit notice (cooling-off for high-impact edits) and D29 guardian
// recovery (standbys, availability, rotation, resignation). The quorum is
// never lowered; a plan short of guardians says so plainly.
import { CircleCheck, Clock3, KeyRound, LifeBuoy, LogOut, ShieldAlert, ShieldCheck, Undo2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isMissingMethod, view } from "@/lib/contract";
import { useConfig } from "@/lib/fees";
import { duration, shortName, when } from "@/lib/plan";
import type { ChangeKind, GuardianSettings, GuardianStatus, PendingChange, PlanView } from "@/lib/types";
import { useConfirm } from "./feedback";
import { Countdown, Field, Segmented } from "./interactive";
import { useTx } from "./tx";
import { Button, Card, Notice, SectionTitle, Skeleton, cx, inputClass } from "./ui";

const MIN = 60_000;
const DAY = 86_400_000;
const STORAGE = 10n ** 22n;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  Plan: "Heirs, shares, destinations, guardians or quorum",
  Guardians: "Standby guardians and availability checks",
  Rules: "Release rules (fixed amounts, alternates, fallback)",
  Options: "How heirs receive (release mode, delay signers)",
  Btc: "Bitcoin destinations",
  Intents: "NEAR Intents delivery",
  Notice: "The edit notice (shorter or off)",
};
export const kindOf = (c: PendingChange) => (Object.keys(c.change)[0] ?? "Plan") as ChangeKind;

export interface Recovery {
  loaded: boolean;
  /** False on a contract without D28/D29. */
  supported: boolean;
  notice: number;
  pending: PendingChange[];
  settings: GuardianSettings | null;
  status: GuardianStatus | null;
  reload: () => Promise<void>;
}

/** Everything D28/D29 the plan screen shows, read together; `key` re-reads on plan changes. */
export function useRecovery(owner: string, key?: unknown): Recovery {
  const [s, set] = useState<Omit<Recovery, "reload">>({ loaded: false, supported: true, notice: 0, pending: [], settings: null, status: null });
  const reload = useCallback(async () => {
    try {
      const [notice, pending, settings, status] = await Promise.all([
        view<number>("get_edit_notice", { owner }),
        view<PendingChange[]>("get_pending_changes", { owner }),
        view<GuardianSettings | null>("get_guardian_settings", { owner }),
        view<GuardianStatus>("get_guardian_status", { owner }),
      ]);
      set({ loaded: true, supported: true, notice, pending, settings, status });
    } catch (e) {
      if (isMissingMethod(e)) set((x) => ({ ...x, loaded: true, supported: false }));
      else set((x) => ({ ...x, loaded: true }));
    }
  }, [owner]);
  useEffect(() => void reload(), [reload, key]);
  return { ...s, reload };
}

/** Demo builds allow minute-scale timers; offer them there. */
function useDemo() {
  return !!useConfig()?.demo_timers;
}

// ------------------------------------------------------------ pending edits

/** Shown to everyone on the plan while an owner edit waits out its notice. */
export function PendingChanges({ owner, me, rec, now, onChanged }: { owner: string; me: string | null; rec: Recovery; now: number; onChanged?: () => unknown }) {
  const { busy, act } = useTx(async () => {
    await rec.reload();
    await onChanged?.();
  });
  if (!rec.pending.length) return null;
  const isOwner = me === owner;
  const due = rec.pending.filter((c) => c.effective_at_ms <= now);
  return (
    <Notice
      tone="warn"
      title={isOwner ? "Your changes are waiting out the edit notice" : `${shortName(owner)}'s plan has changes waiting`}
      action={
        me && due.length ? (
          <Button size="sm" variant="ink" icon={CircleCheck} loading={busy === "Apply changes"} onClick={() => void act("Apply changes", "apply_changes", { owner, kind: null }, { done: "Changes applied." })}>
            Apply {due.length === rec.pending.length ? "now" : `${due.length} due`}
          </Button>
        ) : undefined
      }
    >
      <p>
        {isOwner
          ? "High-impact edits take effect only after the notice you chose, so nobody who gets into your account can quietly re-route the plan. Your guardians and heirs have been told."
          : `If ${shortName(owner)} didn't make these changes, tell them now: they can cancel until the time shown. Until then the plan works as before.`}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {rec.pending.map((c) => {
          const k = kindOf(c);
          const ready = c.effective_at_ms <= now;
          return (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-row bg-card/60 px-3 py-2 text-ink">
              <span className="font-medium">{CHANGE_LABEL[k]}</span>
              <span className="flex items-center gap-2 text-sm text-muted">
                {ready ? "ready to apply" : <Countdown to={c.effective_at_ms} now={now} prefix="takes effect in " />}
                {isOwner && (
                  <Button size="sm" variant="outline" icon={Undo2} disabled={!!busy} onClick={() => void act(`Cancel the change to ${CHANGE_LABEL[k].toLowerCase()}`, "cancel_change", { kind: k }, { done: "Change cancelled. Nothing was changed." })}>
                    Cancel
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}

// ------------------------------------------------------------ edit notice

const NOTICE_CHOICES = [0, 1, 3, 7, 14, 30].map((d) => d * DAY);
const NOTICE_DEMO = [2 * MIN, 10 * MIN];

export function EditNoticeCard({ rec, editable }: { rec: Recovery; editable: boolean }) {
  const demo = useDemo();
  const [pick, setPick] = useState<number | null>(null);
  const { busy, act } = useTx(rec.reload);
  if (!rec.supported) return null;
  const choices = [...new Set([...(demo ? NOTICE_DEMO : []), ...NOTICE_CHOICES, rec.notice])].sort((a, b) => a - b);
  const value = pick ?? rec.notice;
  const label = (ms: number) => (ms === 0 ? "Off" : duration(ms));
  const lowering = value < rec.notice;
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={Clock3}
        title="Edit notice"
        sub="A cooling-off period for big changes: heirs, shares, destinations, guardians, quorum, release mode and standbys. They take effect only after the notice, everyone on the plan is told, and you can cancel. Check-ins, timers and withdrawals stay instant."
      />
      {!rec.loaded ? (
        <Skeleton className="h-12" />
      ) : editable ? (
        <>
          <Segmented label="Edit notice" size="sm" value={String(value)} onChange={(v) => setPick(Number(v))} options={choices.map((ms) => ({ value: String(ms), label: label(ms) }))} />
          {lowering && <Notice tone="info">Shortening or turning off the notice waits out the current one ({duration(rec.notice)}), so a stolen key can't switch it off first.</Notice>}
          <Button
            variant="ink"
            className="self-start"
            disabled={value === rec.notice}
            loading={!!busy}
            onClick={() => void act(value ? `Set the edit notice to ${duration(value)}` : "Turn the edit notice off", "set_edit_notice", { notice_ms: value }, { deposit: STORAGE, done: lowering ? `Requested. It takes effect in ${duration(rec.notice)}.` : "Edit notice saved." })}
          >
            Save
          </Button>
        </>
      ) : (
        <p className="text-sm">{rec.notice ? `Big changes wait ${duration(rec.notice)} before taking effect.` : "Off: changes take effect at once."}</p>
      )}
    </Card>
  );
}

// ------------------------------------------------------------ guardian health

const AVAIL_CHOICES = [0, 30, 60, 90, 180].map((d) => d * DAY);
const AVAIL_DEMO = [5 * MIN, 30 * MIN];
const SWAP_CHOICES = [1, 3, 7, 14].map((d) => d * DAY);
const SWAP_DEMO = [2 * MIN, 10 * MIN];

function Seat({ account, seen, available, resigned, tracking, now }: { account: string; seen: number | null; available: boolean; resigned: boolean; tracking: boolean; now: number }) {
  const tone = resigned ? "text-error" : available ? "text-ok" : "text-warn";
  const state = resigned ? "resigned" : !tracking ? "no availability checks" : available ? "available" : "hasn't confirmed";
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-mono text-[13px]">{account}</span>
      <span className={cx("text-xs", tone)}>
        {state}
        {tracking && seen !== null && !resigned && ` · last seen ${now - seen < DAY ? "today" : `${Math.floor((now - seen) / DAY)} days ago`}`}
      </span>
    </span>
  );
}

/**
 * Who can approve a release right now, standbys, and seat changes in flight.
 * Anyone signed in can call a standby or finish a due change; the owner can
 * cancel and (when `editable`) change the settings.
 */
export function GuardianHealthCard({ planView, rec, me, now, editable }: { planView: PlanView; rec: Recovery; me: string | null; now: number; editable: boolean }) {
  const owner = planView.plan.owner;
  const isOwner = me === owner;
  const st = rec.status;
  const { busy, act } = useTx(rec.reload);
  if (!rec.supported) return null;
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={st && !st.quorum_reachable ? ShieldAlert : ShieldCheck}
        title="Guardian health"
        sub={`${planView.plan.policy.quorum} of ${planView.plan.policy.guardians.length} guardians must approve a release. Behest never lowers that number; standbys fill empty seats instead.`}
      />
      {!st ? (
        <Skeleton className="h-24" />
      ) : (
        <>
          {!st.quorum_reachable && (
            <Notice tone="error" title="Not enough guardians to approve a release">
              Only {st.available} of {st.guardians.length} are available and {st.quorum} are needed. A release waits until a standby takes a seat, a guardian confirms, or {isOwner ? "you name" : `${shortName(owner)} names`} new guardians.
            </Notice>
          )}
          <ul className="flex flex-col divide-y divide-line rounded-row border border-line">
            {st.guardians.map((g) => {
              const change = st.pending.find((c) => c.out === g.account_id);
              return (
                <li key={g.account_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <Seat account={g.account_id} seen={g.last_seen_ms} available={g.available} resigned={g.resigned} tracking={st.tracking} now={now} />
                  <span className="flex flex-wrap items-center gap-2">
                    {change && (
                      <span className="text-xs text-muted">
                        {change.kind === "Rotation" ? `moving to ${change.into}` : `${change.into} takes the seat`} {change.effective_at_ms > now ? <Countdown to={change.effective_at_ms} now={now} prefix="in " /> : "now"}
                      </span>
                    )}
                    {me && change && change.effective_at_ms <= now && (
                      <Button size="sm" variant="ink" disabled={!!busy} onClick={() => void act("Complete the seat change", "finalize_guardian_change", { owner, guardian: g.account_id }, { done: `${change.into} now holds the seat.` })}>
                        Complete
                      </Button>
                    )}
                    {change && (isOwner || me === g.account_id) && (
                      <Button size="sm" variant="outline" icon={Undo2} disabled={!!busy} onClick={() => void act("Cancel the seat change", "cancel_guardian_change", { owner, guardian: g.account_id }, { done: "Seat change cancelled." })}>
                        Cancel
                      </Button>
                    )}
                    {me && g.replaceable && (
                      <Button size="sm" variant="outline" icon={UserPlus} disabled={!!busy} onClick={() => void act("Call a standby", "request_standby", { owner, guardian: g.account_id }, { done: g.resigned ? "The standby took the seat." : `Requested. The standby takes the seat after ${duration(st.swap_delay_ms)} unless ${shortName(g.account_id)} confirms.` })}>
                        Call a standby
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {st.standbys.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-muted">Standbys, in order</span>
              <ul className="flex flex-col gap-1.5">
                {st.standbys.map((s) => (
                  <li key={s.account_id}>
                    <Seat account={s.account_id} seen={s.last_seen_ms} available={s.available} resigned={false} tracking={st.tracking} now={now} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isOwner && editable && <GuardianSettingsForm rec={rec} onSaved={rec.reload} />}
          {isOwner && !editable && <p className="text-sm text-muted">Standby settings can be changed once the open release is closed.</p>}
        </>
      )}
    </Card>
  );
}

function GuardianSettingsForm({ rec, onSaved }: { rec: Recovery; onSaved: () => unknown }) {
  const demo = useDemo();
  const cur = rec.settings;
  const [standbys, setStandbys] = useState((cur?.standbys ?? []).join("\n"));
  const [avail, setAvail] = useState(cur?.availability_ms ?? 0);
  const [swap, setSwap] = useState(cur?.swap_delay_ms ?? 3 * DAY);
  const [err, setErr] = useState<string | null>(null);
  const { busy, act } = useTx(onSaved);
  useEffect(() => {
    setStandbys((cur?.standbys ?? []).join("\n"));
    setAvail(cur?.availability_ms ?? 0);
    setSwap(cur?.swap_delay_ms ?? 3 * DAY);
  }, [cur]);
  const list = [...new Set(standbys.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const availChoices = [...new Set([...(demo ? AVAIL_DEMO : []), ...AVAIL_CHOICES, avail])].sort((a, b) => a - b);
  const swapChoices = [...new Set([...(demo ? SWAP_DEMO : []), ...SWAP_CHOICES, swap])].sort((a, b) => a - b);
  const clearing = !list.length && avail === 0;
  const next: GuardianSettings | null = clearing ? null : { standbys: list, availability_ms: avail, swap_delay_ms: swap };
  const changed = JSON.stringify(next) !== JSON.stringify(cur);

  async function save() {
    const bad = list.find((a) => !ACCOUNT.test(a) || a.length < 2 || a.length > 64);
    if (bad) return setErr(`${bad} isn't a NEAR account.`);
    if (list.length > 5) return setErr("At most 5 standbys.");
    setErr(null);
    const queued = rec.notice > 0;
    await act(clearing ? "Remove standby settings" : "Save standby settings", "set_guardian_settings", { settings: next }, { deposit: STORAGE, done: queued ? `Saved. It takes effect when your edit notice ends (${duration(rec.notice)}).` : "Standby settings saved." });
  }

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <Field label="Standby guardians, in order" hint="Up to 5 people who step in when a guardian resigns or stops responding. They count toward your tier's guardian limit and can't be heirs or alternates." error={err}>
        {(c) => <textarea {...c} rows={Math.max(2, list.length + 1)} className={cx(inputClass, "font-mono text-[13px]")} value={standbys} onChange={(e) => setStandbys(e.target.value)} spellCheck={false} placeholder="sade.testnet" />}
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Availability checks</span>
        <span className="text-sm text-muted">Guardians confirm they're still around (any vote counts). One who hasn't within this window can be replaced by a standby.</span>
        <Segmented label="Availability window" size="sm" value={String(avail)} onChange={(v) => setAvail(Number(v))} options={availChoices.map((ms) => ({ value: String(ms), label: ms ? duration(ms) : "Off" }))} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Swap notice</span>
        <span className="text-sm text-muted">How long a standby (or a guardian's new key) waits before taking a seat. You can cancel during it; the guardian stops it just by confirming.</span>
        <Segmented label="Swap notice" size="sm" value={String(swap)} onChange={(v) => setSwap(Number(v))} options={swapChoices.map((ms) => ({ value: String(ms), label: duration(ms) }))} />
      </div>
      <Button variant="ink" icon={LifeBuoy} className="self-start" disabled={!changed} loading={!!busy} onClick={() => void save()}>
        {clearing && cur ? "Remove standby settings" : "Save standby settings"}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------ guardian's own seat

/** For a guardian: confirm, move the seat to a new key, or step down. */
export function MySeatCard({ owner, me, rec, now }: { owner: string; me: string; rec: Recovery; now: number }) {
  const confirm = useConfirm();
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { busy, act } = useTx(rec.reload);
  const st = rec.status;
  if (!rec.supported || !st) return null;
  const seat = st.guardians.find((g) => g.account_id === me);
  if (!seat || seat.resigned) return null;
  const mine = st.pending.find((c) => c.out === me);
  const due = st.tracking && seat.last_seen_ms !== null ? seat.last_seen_ms + st.availability_ms : null;

  async function rotate() {
    const a = to.trim().toLowerCase();
    if (!ACCOUNT.test(a) || a.length < 2 || a.length > 64) return setErr("That isn't a NEAR account.");
    setErr(null);
    if (await act("Move my guardian seat", "rotate_guardian", { owner, new_account: a }, { done: `Requested. ${a} takes your seat after ${duration(st!.swap_delay_ms)}.` })) setTo("");
  }
  async function resign() {
    const standby = st!.standbys.some((s) => s.available);
    const ok = await confirm({
      title: "Step down as a guardian?",
      body: standby ? "The next standby takes your seat at once. You can't undo this." : `There's no standby, so your seat stays empty and ${st!.quorum} of the remaining guardians must still approve. You can't undo this.`,
      confirmLabel: "Step down",
      tone: "danger",
    });
    if (ok) await act("Step down as a guardian", "resign_guardian", { owner }, { done: "You've stepped down." });
  }

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={KeyRound} title="Your guardian seat" sub={st.tracking ? `Confirm at least every ${duration(st.availability_ms)} so ${shortName(owner)}'s standby isn't called in.` : "Keep your seat current: move it to a new key, or step down if you can't serve."} />
      {mine && mine.kind === "Standby" && <Notice tone="warn" title="A standby has been asked to take your seat">Confirm below to keep it.</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={CircleCheck} loading={busy === "Confirm I'm available"} disabled={!!busy} onClick={() => void act("Confirm I'm available", "confirm_guardian", { owner }, { done: "Thanks, you're confirmed." })}>
          I'm still available
        </Button>
        {due !== null && <span className="text-sm text-muted">{due > now ? <Countdown to={due} now={now} prefix="confirm within " /> : "past the window: confirm now"}</span>}
      </div>
      {mine?.kind === "Rotation" ? (
        <Notice tone="info" title={`Moving your seat to ${mine.into}`}>
          It lands {when(mine.effective_at_ms)}. Cancel it from Guardian health if you didn't ask for this.
        </Notice>
      ) : (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <Field label="Move my seat to a new account" hint={`For a new wallet or key. It lands after ${duration(st.swap_delay_ms)}; ${shortName(owner)} can cancel.`} error={err}>
            {(c) => <input {...c} className={cx(inputClass, "font-mono text-[13px]")} value={to} onChange={(e) => setTo(e.target.value)} placeholder="new-account.testnet" autoComplete="off" spellCheck={false} />}
          </Field>
          <Button variant="outline" className="self-start" disabled={!to || !!busy} onClick={() => void rotate()}>
            Request the move
          </Button>
        </div>
      )}
      <Button variant="subtle" icon={LogOut} className="self-start" disabled={!!busy} onClick={() => void resign()}>
        Step down
      </Button>
    </Card>
  );
}

/** For a standby: what that means, and the confirm button. */
export function StandbyCard({ owner, me, rec, now }: { owner: string; me: string | null; rec: Recovery; now: number }) {
  const { busy, act } = useTx(rec.reload);
  const st = rec.status;
  const seat = me ? st?.standbys.find((s) => s.account_id === me) : undefined;
  if (!st || !seat || !me) return null;
  const n = st.standbys.findIndex((s) => s.account_id === me) + 1;
  const due = st.tracking && seat.last_seen_ms !== null ? seat.last_seen_ms + st.availability_ms : null;
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={LifeBuoy} title="You're a standby guardian" sub={`Standby #${n} for ${shortName(owner)}'s plan. If a guardian steps down or stops responding, you may be asked to take their seat. Until then you have no vote.`} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={CircleCheck} loading={!!busy} onClick={() => void act("Confirm I'm available", "confirm_guardian", { owner }, { done: "Thanks, you're confirmed." })}>
          I'm still available
        </Button>
        {due !== null && <span className="text-sm text-muted">{due > now ? <Countdown to={due} now={now} prefix="confirm within " /> : "past the window: confirm to be called on"}</span>}
      </div>
    </Card>
  );
}
