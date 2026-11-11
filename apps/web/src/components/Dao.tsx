"use client";
// D26: DAOs and multisigs in any role. The DAO picker (act as a SputnikDAO you
// sit on), the banner shown while acting as one, the DAO's pending Behest
// proposals with Approve / Reject (act_proposal), the owner's check-in
// delegates, and the check-in button a delegate sees on the owner's plan.
import { ArrowUpRight, Check, Landmark, LogOut, UserCheck, Users, Vote, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NEAR_EXPLORER } from "@/lib/config";
import { view } from "@/lib/contract";
import {
  DAO_SUFFIX,
  STATUS_WORDS,
  VOTE_TGAS,
  concerns,
  councilOf,
  formatNear,
  formatPeriod,
  getPolicy,
  isOpen,
  powers,
  proposalPeriodMs,
  recentProposals,
  rolesOf,
  trezuAvailable,
  trezuUrl,
  voteRule,
  type DaoPolicy,
  type DaoProposal,
} from "@/lib/dao";
import { humanError } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { getTierConfig } from "@/lib/tiers";
import { useToast } from "./feedback";
import { Dialog, Field } from "./interactive";
import { useTx } from "./tx";
import { Button, Card, ExtLink, Notice, SectionTitle, Skeleton, cx, inputClass } from "./ui";

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** "family" → "family.sputnikv2.testnet"; full account ids pass through. */
export const daoId = (s: string) => {
  const v = s.trim().toLowerCase();
  return v.includes(".") ? v : `${v}${DAO_SUFFIX}`;
};

// ------------------------------------------------------------------ picker

export function DaoPicker({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: (dao: string) => void }) {
  const { session, actAsDao } = useSession();
  const member = session?.dao?.member ?? session;
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<DaoPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = name.trim() ? daoId(name) : "";

  useEffect(() => {
    setPolicy(null);
    setError(null);
    if (!id || !ACCOUNT.test(id)) return;
    let live = true;
    const t = setTimeout(() => {
      getPolicy(id).then(
        (p) => live && setPolicy(p),
        () => live && setError(`${id} isn't a SputnikDAO, or the network didn't answer.`),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id]);

  if (!member) return null;
  const evm = member.kind === "evm";
  const p = policy ? powers(policy, member.accountId) : null;
  const roles = policy ? rolesOf(policy, member.accountId) : [];

  async function go() {
    setBusy(true);
    try {
      await actAsDao(id);
      onClose();
      onDone?.(id);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Act as a DAO"
      description="A DAO or multisig can own a plan, guard one, inherit or sign for more time. Each action you take becomes a proposal in the DAO; it runs once the council approves."
    >
      {evm ? (
        <Notice tone="warn">SputnikDAO proposals are NEAR transactions. Sign in with a NEAR wallet to propose for a DAO.</Notice>
      ) : (
        <>
          <Field label="DAO account" hint={`The name on ${DAO_SUFFIX.slice(1)} (e.g. "family"), or a full account id.`} error={error}>
            {(c) => <input {...c} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={`family${DAO_SUFFIX}`} autoComplete="off" spellCheck={false} />}
          </Field>
          {id && !policy && !error && <Skeleton className="h-28" />}
          {policy && p && (
            <div className="flex flex-col gap-3 rounded-row border border-line bg-card p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Landmark aria-hidden className="size-4 text-muted" />
                <span className="font-mono text-[13px]">{id}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt className="text-muted">Your roles</dt>
                <dd>{roles.map((r) => r.name).join(", ") || "none"}</dd>
                <dt className="text-muted">You can</dt>
                <dd>{[p.propose && "propose", p.approve && "approve", p.reject && "reject"].filter(Boolean).join(", ") || "only watch"}</dd>
                <dt className="text-muted">Passing</dt>
                <dd>{voteRule(policy)}</dd>
                <dt className="text-muted">Bond</dt>
                <dd>{formatNear(policy.proposal_bond)} per proposal, returned when it's decided</dd>
                <dt className="text-muted">Voting window</dt>
                <dd>{formatPeriod(proposalPeriodMs(policy))}</dd>
              </dl>
              {!p.propose && <Notice tone="warn">Your roles in this DAO can't add function-call proposals.</Notice>}
            </div>
          )}
          <Button variant="primary" icon={Landmark} disabled={!policy || !p?.propose} loading={busy} onClick={() => void go()}>
            Act as {id || "this DAO"}
          </Button>
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ banner

/** Shown while acting as a DAO: who proposes, how proposals pass, and the way back. */
export function DaoBanner() {
  const { session, leaveDao } = useSession();
  if (!session?.dao) return null;
  const { id, member, policy } = session.dao;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-row border border-signal bg-s-approved p-3 text-sm">
      <Landmark aria-hidden className="size-[18px] shrink-0" />
      <span className="min-w-0 flex-1">
        Acting as <b className="font-mono text-[13px]">{id}</b>. {member.accountId} proposes; each action runs once it has {voteRule(policy)}.
      </span>
      <Button size="sm" variant="outline" icon={LogOut} onClick={leaveDao}>
        Back to {member.label}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ proposals

function useDaoProposals(dao: string | null, owner: string) {
  const [list, setList] = useState<DaoProposal[] | null>(null);
  const [feeToken, setFeeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!dao) return;
    try {
      const fee = await getTierConfig()
        .then((c) => c.fee_token)
        .catch(() => null);
      setFeeToken(fee);
      setList((await recentProposals(dao, 40)).filter((p) => concerns(p, dao, owner, fee)));
      setError(null);
    } catch (e) {
      setError(humanError(e));
    }
  }, [dao, owner]);
  useEffect(() => {
    setList(null);
    void reload();
    const t = setInterval(() => void reload(), 8000);
    return () => clearInterval(t);
  }, [reload]);
  return { list, feeToken, error, reload };
}

/** The DAO's Behest proposals about this plan: open ones with votes, then the last few decided. */
export function DaoProposals({ owner, onChange }: { owner: string; onChange?: () => unknown }) {
  const { session } = useSession();
  const dao = session?.dao ?? null;
  const { list, error, reload } = useDaoProposals(dao?.id ?? null, owner);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!dao) return null;
  const { member, policy, id } = dao;
  const p = powers(policy, member.accountId);
  const now = Date.now();
  const open = (list ?? []).filter((x) => isOpen(x, policy, now));
  const done = (list ?? []).filter((x) => !isOpen(x, policy, now)).slice(0, 5);

  async function vote(x: DaoProposal, action: "VoteApprove" | "VoteReject") {
    const key = `${x.id}:${action}`;
    setBusy(key);
    const t = toast.show({ tone: "pending", title: `${action === "VoteApprove" ? "Approving" : "Rejecting"} #${x.id}…`, body: "Confirm in your wallet." });
    try {
      const r = await member.call("act_proposal", { id: x.id, action, memo: "Behest" }, { receiverId: id, tgas: VOTE_TGAS });
      await reload();
      await Promise.resolve(onChange?.()).catch(() => {});
      const after = await view<DaoProposal>("get_proposal", { id: x.id }, id).catch(() => null);
      const words = after ? STATUS_WORDS[after.status] : "Vote counted";
      toast.update(t, { tone: after?.status === "Failed" ? "error" : "ok", title: `#${x.id}: ${words}`, href: r.txHash ? `${NEAR_EXPLORER}/txns/${r.txHash}` : undefined });
    } catch (e) {
      toast.update(t, { tone: "error", title: `Vote on #${x.id} didn't go through`, body: humanError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={Vote}
        title="DAO proposals"
        sub={`${id}'s proposals about this plan. Each needs ${voteRule(policy)}.`}
        aside={trezuAvailable ? <ExtLink href={trezuUrl(id)}>Open in Trezu</ExtLink> : undefined}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {list === null && !error && <Skeleton className="h-16" />}
      {list && open.length === 0 && <p className="text-sm text-muted">Nothing waiting for votes.</p>}
      <ul className="flex flex-col gap-2">
        {open.map((x) => {
          const mine = x.votes[member.accountId];
          return (
            <li key={x.id} className="flex flex-col gap-3 rounded-row border border-line p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  #{x.id} · {x.description.replace(/ · via Behest$/, "")}
                </span>
                <span className="text-xs text-muted">by {x.proposer}</span>
              </div>
              <Votes x={x} policy={policy} />
              <div className="flex flex-wrap items-center gap-2">
                {mine ? (
                  <span className="text-sm text-muted">You voted {mine === "Approve" ? "to approve" : mine === "Reject" ? "to reject" : "to remove"}.</span>
                ) : (
                  <>
                    <Button size="sm" variant="primary" icon={Check} disabled={!p.approve || !!busy} loading={busy === `${x.id}:VoteApprove`} onClick={() => void vote(x, "VoteApprove")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" icon={X} disabled={!p.reject || !!busy} loading={busy === `${x.id}:VoteReject`} onClick={() => void vote(x, "VoteReject")}>
                      Reject
                    </Button>
                  </>
                )}
                {trezuAvailable && (
                  <a href={trezuUrl(id, x.id)} target="_blank" rel="noreferrer" className="ml-auto inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-ink">
                    Trezu <ArrowUpRight aria-hidden className="size-4" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {done.length > 0 && (
        <ul className="flex flex-col divide-y divide-line text-sm">
          {done.map((x) => (
            <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <span className="min-w-0 flex-1 truncate">
                #{x.id} · {x.description.replace(/ · via Behest$/, "")}
              </span>
              <span className={cx("text-xs font-semibold", x.status === "Approved" ? "text-ok" : x.status === "Failed" ? "text-error" : "text-muted")}>{x.status === "InProgress" ? "Expired" : STATUS_WORDS[x.status]}</span>
            </li>
          ))}
        </ul>
      )}
      {!trezuAvailable && <p className="text-xs text-muted">Trezu manages mainnet DAOs; on testnet, vote here or in any SputnikDAO app.</p>}
    </Card>
  );
}

function Votes({ x, policy }: { x: DaoProposal; policy: DaoPolicy }) {
  const council = councilOf(policy);
  const approvals = Object.values(x.votes).filter((v) => v === "Approve").length;
  const rejections = Object.values(x.votes).filter((v) => v === "Reject").length;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <span>
        <b className="text-ink">{approvals}</b> approve · <b className="text-ink">{rejections}</b> reject · {voteRule(policy)} to pass
      </span>
      <span className="flex gap-1" aria-hidden>
        {council.map((m) => (
          <span key={m} title={`${m}: ${x.votes[m] ?? "not voted"}`} className={cx("size-2.5 rounded-full", x.votes[m] === "Approve" ? "bg-ok" : x.votes[m] === "Reject" ? "bg-error" : "bg-line-strong")} />
        ))}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ delegates

export const getDelegates = (owner: string) => view<string[]>("get_checkin_delegates", { owner }).catch(() => [] as string[]);

/** Owner: up to 10 accounts that may check in and nothing else (a Standard tier feature). */
export function DelegatesCard({ owner, editable, onSaved }: { owner: string; editable: boolean; onSaved?: () => unknown }) {
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { busy, act } = useTx(async () => {
    const d = await getDelegates(owner);
    setSaved(d);
    await onSaved?.();
  });
  useEffect(() => {
    void getDelegates(owner).then((d) => {
      setSaved(d);
      setDraft(d.join("\n"));
    });
  }, [owner]);

  const list = [...new Set(draft.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const changed = saved !== null && list.join() !== saved.join();

  async function save() {
    const bad = list.find((a) => !ACCOUNT.test(a) || a.length < 2 || a.length > 64);
    if (bad) return setErr(`${bad} isn't a NEAR account.`);
    if (list.length > 10) return setErr("At most 10 delegates.");
    if (list.includes(owner)) return setErr("The owner checks in anyway; leave them out.");
    setErr(null);
    await act(list.length ? "Save check-in delegates" : "Remove check-in delegates", "set_checkin_delegates", { delegates: list }, list.length ? { deposit: 10n ** 22n } : {});
  }

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={UserCheck} title="Check-in delegates" sub="People who may check in for this plan and do nothing else: no withdrawals, edits or cancelling a release. Useful when a DAO owns the plan and its votes take days." />
      {saved === null ? (
        <Skeleton className="h-20" />
      ) : editable ? (
        <>
          <Field label="Accounts, one per line" hint="Up to 10. Needs the Standard tier." error={err}>
            {(c) => <textarea {...c} rows={Math.max(2, list.length + 1)} className={cx(inputClass, "font-mono text-[13px]")} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />}
          </Field>
          <Button variant="ink" disabled={!changed} loading={!!busy} onClick={() => void save()} className="self-start">
            {list.length || !saved.length ? "Save delegates" : "Remove all delegates"}
          </Button>
        </>
      ) : saved.length ? (
        <ul className="flex flex-col gap-1 font-mono text-[13px]">
          {saved.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">None.</p>
      )}
    </Card>
  );
}

/** A delegate on the owner's plan: one button, and it says what it can't do. */
export function DelegateCheckIn({ owner, me, open, onDone }: { owner: string; me: string; open: boolean; onDone?: () => unknown }) {
  const [isDelegate, setIsDelegate] = useState(false);
  const { busy, act } = useTx(onDone);
  useEffect(() => {
    if (!me || me === owner) return setIsDelegate(false);
    void getDelegates(owner).then((d) => setIsDelegate(d.includes(me)));
  }, [owner, me]);
  if (!isDelegate) return null;
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={Users} title="You're a check-in delegate" sub={`You can check in for ${owner}, which restarts the plan's clock. You can't change, withdraw from or cancel anything.`} />
      {open ? (
        <Notice tone="warn">A release is open. Only the owner can stop it by checking in; a delegate can't.</Notice>
      ) : (
        <Button variant="primary" icon={UserCheck} loading={!!busy} className="self-start" onClick={() => void act(`Check in for ${owner}`, "check_in", { owner }, { summary: `Check in for ${owner}` })}>
          Check in for {owner}
        </Button>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ wizard

/** True for accounts with a SputnikDAO policy (checked once per account). */
export function useDaoAccounts(accounts: string[]) {
  const [daos, setDaos] = useState<Record<string, boolean>>({});
  const key = accounts.filter((a) => ACCOUNT.test(a) && a.includes(".")).join(",");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      for (const a of key ? key.split(",") : []) {
        if (a in daos) continue;
        getPolicy(a).then(
          () => live && setDaos((d) => ({ ...d, [a]: true })),
          () => live && setDaos((d) => ({ ...d, [a]: false })),
        );
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return daos;
}

/**
 * Setup advice for DAOs (D26): an owner DAO pays its own storage (shown up
 * front, never a SponsorRefused at the end), a check-in interval that leaves
 * room for several proposal periods (or check-in delegates), and DAO heirs
 * on Automatic or Hybrid release so they're paid without a proposal.
 */
export function DaoSetupNotes({ step, intervalMs, heirs, mode }: { step: string; intervalMs: number; heirs: string[]; mode: string | null }) {
  const { session } = useSession();
  const daos = useDaoAccounts(heirs);
  const daoHeirs = heirs.filter((h) => daos[h]);
  const dao = session?.dao;
  const out: ReactNode[] = [];
  if (dao && (step === "timing" || step === "funding" || step === "review")) {
    out.push(
      <Notice key="storage" tone="info" title="The DAO pays its plan's storage">
        Saving becomes one proposal to {dao.id}: it attaches about 0.1 NEAR from the DAO for the plan's storage (the contract refunds what it doesn't use) plus anything you put in now. Behest's free storage pool only covers transactions its relayer signs, and a DAO's call is
        signed by the council member who casts the deciding vote. {member(dao.member.accountId)} attaches the {formatNear(dao.policy.proposal_bond)} proposal bond, returned once the proposal is decided.
      </Notice>,
    );
  }
  if (dao && (step === "timing" || step === "review")) {
    const period = proposalPeriodMs(dao.policy);
    const advice = intervalMs > 0 ? (intervalMs <= period ? "too_short" : intervalMs < 4 * period ? "tight" : "ok") : "ok";
    if (advice !== "ok") {
      out.push(
        <Notice key="interval" tone="warn" title={advice === "too_short" ? "The DAO can't check in that often" : "Check-ins will be tight"}>
          Every check-in by the DAO is a proposal that can take up to {formatPeriod(period)} to pass. {advice === "too_short" ? "This interval is shorter than that." : "This interval leaves room for fewer than four of them."} Choose a longer interval, or name council members as check-in delegates
          once the plan is saved (Standard tier): a delegate checks in with one signature and can do nothing else.
        </Notice>,
      );
    }
  }
  if (daoHeirs.length > 0 && (step === "heirs" || step === "review") && (mode === null || mode === "Claim")) {
    out.push(
      <Notice key="heir" tone="warn" title={`${daoHeirs.join(", ")} ${daoHeirs.length === 1 ? "is a DAO" : "are DAOs"}`}>
        With heirs claiming, a DAO needs a proposal and a vote to collect its share, and the claim window keeps running meanwhile. After saving, set the release mode to Automatic or Hybrid on the plan page (Complete tier) so the DAO is paid without acting.
      </Notice>,
    );
  }
  return out.length ? <div className="flex flex-col gap-3">{out}</div> : null;
}

const member = (a: string) => (a.length > 24 ? `${a.slice(0, 22)}…` : a);
