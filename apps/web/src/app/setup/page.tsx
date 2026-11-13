"use client";
// Plan creation and editing as a guided wizard: timing, guardians, heirs,
// funding, then a plain-language review before anything is signed.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CircleCheck, Coins, Compass, Hourglass, Divide, Gift, Mail, Pencil, Plus, RotateCcw, ScrollText, ShieldCheck, Timer, Trash2, UserRound, Wallet, WifiOff, type LucideIcon } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { Disclosure, Field, Segmented, Term } from "@/components/interactive";
import { HeirList, ShareBar } from "@/components/PlanParts";
import { Swap } from "@/components/motion";
import { SignInDialog } from "@/components/SignIn";
import { TierNeeded } from "@/components/Tiers";
import { DaoBanner, DaoSetupNotes } from "@/components/Dao";
import { SummaryList } from "@/components/Summary";
import { PRESETS, applyPreset, editedFrom, presetValues, type PresetId } from "@/lib/presets";
import { planSummary } from "@/lib/summary";
import { commitment, downloadJson, localRecords, matching, recordFile, saveLocalRecords, type HeirRecord, type PrivateView, type Unrevealed } from "@/lib/sealed";
import { backupRecords, getInfo } from "@/lib/notify";
import { localPeople, namePerson, peopleError, type PersonRole } from "@/lib/people";
import { IntentsBridgeAddress } from "@/components/Intents";
import { Button, ButtonLink, Card, EmptyState, Notice, SectionTitle, Skeleton, cx, inputClass } from "@/components/ui";
import { getBtcDestinations, getConfig, getPlan, getSponsorship, sponsorshipAvailable, view as viewCall, type Sponsorship } from "@/lib/contract";
import type { DaoCall } from "@/lib/dao";
import { getIntentsConfig, getIntentsDelivery, type IntentsConfig, type IntentsDelivery } from "@/lib/intents";
import { humanError } from "@/lib/hooks";
import { describePlan, duration, parseNear, percent, shortAddr, shortName, validateDraft } from "@/lib/plan";
import { SponsorRefused, useSession } from "@/lib/session";
import { features, formatUsd, reasonFor, requiredTier, useTier, useTierConfig } from "@/lib/tiers";
import type { PlanInput, PlanView, ReleaseOptions, ReleaseRules } from "@/lib/types";
import {
  WIZARD_STEPS,
  accountOf,
  fromMs,
  guardianErrors,
  heirErrors,
  intentsDeliveries,
  kindOf,
  looksLikeEmail,
  sharesTotal,
  splitEvenly,
  timingErrors,
  toMs,
  unresolvedEmails,
  type EmailAccounts,
  type FieldErrors,
  type HeirDraft,
  type PersonKind,
  type TimerDraft,
  type Unit,
  UNIT_MS,
  type WizardStep,
} from "@/lib/wizard";
import { BehestLoader } from "@/components/BehestLoader";

/** Storage for set_intents_delivery; the contract refunds what it doesn't use. */
const INTENTS_DEPOSIT = 10_000_000_000_000_000_000_000n;

const STEP_META: Record<WizardStep, { label: string; icon: LucideIcon; title: string; lede: string }> = {
  start: { label: "Start", icon: Compass, title: "Pick a starting point.", lede: "A preset fills in the settings for you. You can change any of them later." },
  timing: { label: "Timing", icon: Timer, title: "How often will you check in?", lede: "Miss a check-in and the grace period, and your guardians may start a release. You can cancel until the waiting period ends." },
  guardians: { label: "Guardians", icon: ShieldCheck, title: "Who watches over the plan?", lede: "People you trust to notice you're unreachable. They can only release the plan exactly as written, never change where funds go." },
  heirs: { label: "Heirs", icon: Gift, title: "Who receives what?", lede: "Give each person a share. An email address is all you need for them; nobody else can change who receives." },
  funding: { label: "Funding", icon: Coins, title: "What goes in now?", lede: "Put some NEAR into the plan. Ethereum and Bitcoin vaults appear on your plan page once it's saved." },
  review: { label: "Review", icon: ScrollText, title: "Read it once more.", lede: "This is exactly what you're signing. Nothing is sent until you confirm in your wallet." },
};

const EMAIL_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const DRAFT_KEY = "behest.setup-draft";
interface Draft {
  checkIn: TimerDraft;
  grace: TimerDraft;
  waiting: TimerDraft;
  guardians: string[];
  /** How each guardian row is named (same order as `guardians`; a missing entry is read from what was typed). */
  guardianBy: (PersonKind | undefined)[];
  quorum: string;
  heirs: HeirDraft[];
  deposit: string;
  /** Guided preset the draft started from (null: not chosen yet). */
  preset: PresetId | "custom" | null;
  /** D28 edit notice and D29 availability checks, saved after the plan (new plans). */
  notice: number;
  availability: number;
  swapDelay: number;
  /** D33: heirs kept private (sealed commitments on-chain, records off-chain). */
  privacy: "public" | "private";
  revealWindow: number;
  unrevealed: Unrevealed;
  /** Let Behest keep an encrypted copy of the records. */
  backup: boolean;
  /** Email addresses typed for guardians or heirs → the account kept for each (filled in when a step is left). */
  emails: EmailAccounts;
  /** For guardians named by account: where to write to them (key: the account as typed, lowercased). */
  noticeEmails: Record<string, string>;
  /** What the people named here know the owner as; used in emails to them. */
  ownerName: string;
  /** Write to heirs now that they are named (guardians always are). */
  tellHeirs: boolean;
}
const DEMO_DRAFT: Draft = {
  checkIn: { n: "5", unit: "minutes" },
  grace: { n: "0", unit: "minutes" },
  waiting: { n: "5", unit: "minutes" },
  guardians: ["", ""],
  guardianBy: [],
  quorum: "2",
  heirs: [{ account: "", pct: "100", near: "", eth: "" }],
  deposit: "0.5",
  preset: null,
  notice: 0,
  availability: 0,
  swapDelay: 2 * 60_000,
  privacy: "public",
  revealWindow: 5 * 60_000,
  unrevealed: "Redistribute",
  backup: false,
  emails: {},
  noticeEmails: {},
  ownerName: "",
  tellHeirs: false,
};

export default function SetupPage() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}

function Setup() {
  const router = useRouter();
  const asked = useSearchParams().get("edit") === "1";
  const { session, ready } = useSession();
  const [demo, setDemo] = useState(true);
  const [existing, setExisting] = useState<PlanView | null | undefined>(undefined);
  const [d, setD] = useState<Draft>(DEMO_DRAFT);
  const [step, setStep] = useState<WizardStep>("start");
  const [dir, setDir] = useState(1);
  const [tried, setTried] = useState<Partial<Record<WizardStep, boolean>>>({});
  const [phase, setPhase] = useState<"idle" | "plan" | "deposit" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState(false);
  const [ack, setAck] = useState(false);
  const [spons, setSpons] = useState<Sponsorship | null | undefined>(undefined);
  const [paidBy, setPaidBy] = useState<"behest" | "you">("you");
  // D28: the owner's edit notice; with one, big edits wait it out instead of applying.
  const [editNotice, setEditNotice] = useState(0);
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  /** D33: the saved plan is sealed; how many of its records this browser has. */
  const [sealedInfo, setSealedInfo] = useState<{ count: number; known: number } | null>(null);
  /** D33: records made on save, to download before leaving. */
  const [madeRecords, setMadeRecords] = useState<HeirRecord[] | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  /**
   * People can be named by email here. Shown whenever email sign-in is set up for this site, so the
   * fields don't silently turn back into "NEAR account" while the notifier (which creates the
   * accounts) is slow or down: that is reported when an address is actually looked up.
   */
  const [emailOn, setEmailOn] = useState(EMAIL_ENABLED);
  useEffect(() => void getInfo().then((i) => setEmailOn(EMAIL_ENABLED || !!i.email_wallets)).catch(() => {}), []);
  /** Turning typed emails into accounts (leaving the guardians or heirs step). */
  const [resolving, setResolving] = useState(false);
  const [peopleNote, setPeopleNote] = useState<string | null>(null);
  /** D26: acting as a DAO, saving is a proposal; this is its id. */
  const [proposed, setProposed] = useState<number | null | undefined>(undefined);
  // D25: what the saved plan already has beside the policy (rules, options,
  // Bitcoin destinations, token escrow) counts toward the tier it needs.
  const [extras, setExtras] = useState<{ rules: ReleaseRules | null; options: ReleaseOptions | null; btc: number; tokens: boolean; delegates: number; standbys: number }>({ rules: null, options: null, btc: 0, tokens: false, delegates: 0, standbys: 0 });
  // D27: NEAR Intents delivery, when this deployment has a verifier; how many recipients the saved plan opted in.
  const [intentsCfg, setIntentsCfg] = useState<IntentsConfig | null>(null);
  const [savedIntents, setSavedIntents] = useState<IntentsDelivery[]>([]);
  useEffect(() => void getIntentsConfig().then(setIntentsCfg).catch(() => {}), []);
  const tierCfg = useTierConfig();
  const { tier, reload: reloadTier } = useTier(session?.accountId);
  const top = useRef<HTMLDivElement>(null);
  // An owner who already has a plan always edits it (the contract keeps one plan per account).
  const editing = asked || !!existing;
  useEffect(() => {
    if (!session?.accountId || !editing) return;
    void viewCall<number>("get_edit_notice", { owner: session.accountId }).then(setEditNotice, () => setEditNotice(0));
  }, [session?.accountId, editing]);
  const steps = WIZARD_STEPS.filter((s) => !(editing && (s === "funding" || s === "start")));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  useEffect(() => void getConfig().then((c) => setDemo(c.demo_timers)).catch(() => {}), []);
  // A failed read is not "no plan": saving a new plan would replace the real one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => {
    if (!session) return;
    setLoadFailed(false);
    setExisting(undefined);
    // The session can change while this read is out (e.g. re-entering a DAO after a reload): only the latest counts.
    let live = true;
    getPlan(session.accountId)
      .then((v) => {
        if (!live) return;
        setExisting(v);
        if (v) {
          const p = v.plan.policy;
          // People this owner named by email on this browser read as their address again, not the account made for it.
          const known = localPeople(session.accountId);
          const emails: EmailAccounts = {};
          const noticeEmails: Record<string, string> = {};
          const person = (account: string, role: PersonRole) => known.find((k) => k.account === account && k.role === role);
          const entry = (account: string, role: PersonRole) => {
            const k = person(account, role);
            if (!k?.by_email) return account;
            emails[k.email] = { account, near: k.near ?? "", btc: k.btc ?? "" };
            return k.email;
          };
          for (const g of p.guardians) {
            const k = person(g, "guardian");
            if (k && !k.by_email) noticeEmails[g] = k.email;
          }
          setD({
            checkIn: fromMs(p.check_in_interval_ms),
            grace: fromMs(p.grace_ms),
            waiting: fromMs(p.waiting_period_ms),
            guardians: p.guardians.map((g) => entry(g, "guardian")),
            guardianBy: p.guardians.map((g) => (person(g, "guardian")?.by_email ? "email" : "account")),
            quorum: String(p.quorum),
            heirs: p.heirs.map((h) => {
              const k = person(h.account_id, "heir");
              const mine = k?.by_email ? k : null;
              return {
                account: entry(h.account_id, "heir"),
                by: mine ? ("email" as const) : ("account" as const),
                pct: String(h.share_bps / 100),
                near: h.near_destination === h.account_id || (mine && h.near_destination === mine.near) ? "" : (h.near_destination ?? ""),
                eth: mine && h.eth_destination === h.account_id ? "" : (h.eth_destination ?? ""),
                label: k?.label ?? undefined,
                noticeEmail: k && !k.by_email ? k.email : undefined,
              };
            }),
            deposit: "0",
            preset: "custom",
            notice: 0,
            availability: 0,
            swapDelay: 0,
            privacy: "public",
            revealWindow: 5 * 60_000,
            unrevealed: "Redistribute",
            backup: false,
            emails,
            noticeEmails,
            ownerName: "",
            tellHeirs: known.some((k) => k.role === "heir" && k.announce),
          });
          // D33: a sealed plan's heirs come from this browser's records, when they match.
          void viewCall<PrivateView | null>("get_private_heirs", { owner: v.plan.owner })
            .then(async (pv) => {
              if (!live || !pv) return;
              const recs = await matching(v.plan.owner, localRecords(v.plan.owner), pv.commitments);
              setSealedInfo({ count: pv.commitments.length, known: recs.length });
              setD((x) => ({
                ...x,
                privacy: "private",
                revealWindow: pv.reveal_window_ms,
                unrevealed: pv.unrevealed,
                heirs: recs.length === pv.commitments.length ? recs.map((r) => ({ account: r.account_id, pct: String(r.share_bps / 100), near: r.near_destination === r.account_id ? "" : (r.near_destination ?? ""), eth: r.eth_destination ?? "", btc: r.btc_destination ?? "", salt: r.salt })) : [{ account: "", pct: "100", near: "", eth: "" }],
              }));
            })
            .catch(() => {});
          setStep((s) => (s === "start" ? "timing" : s));
        } else {
          try {
            const saved = sessionStorage.getItem(DRAFT_KEY);
            if (saved) setD({ ...DEMO_DRAFT, ...(JSON.parse(saved) as Draft) });
          } catch {}
        }
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [session, loadTry]);
  useEffect(() => {
    if (!existing) return;
    const owner = existing.plan.owner;
    Promise.all([
      viewCall<ReleaseRules | null>("get_release_rules", { owner }).catch(() => null),
      viewCall<ReleaseOptions | null>("get_release_options", { owner }).catch(() => null),
      getBtcDestinations(owner).catch(() => []),
      viewCall<string[]>("get_checkin_delegates", { owner }).catch(() => []),
      // D29: standby guardians count toward the tier's guardian limit
      viewCall<{ standbys: string[] } | null>("get_guardian_settings", { owner }).catch(() => null),
    ]).then(([rules, options, btc, delegates, g]) => setExtras({ rules, options, btc: btc.length, tokens: (existing.ft_escrow ?? []).some((t) => BigInt(t.amount) > 0n), delegates: delegates.length, standbys: g?.standbys.length ?? 0 }));
    getIntentsDelivery(owner)
      .then((ds) => {
        setSavedIntents(ds);
        setD((x) => ({ ...x, heirs: x.heirs.map((h) => {
          const dl = ds.find((y) => y.account_id === h.account.trim().toLowerCase() && y.enabled);
          return dl ? { ...h, intents: true, intentsAccount: dl.intents_account ?? "" } : h;
        }) }));
      })
      .catch(() => {});
  }, [existing]);
  // D24: can Behest's sponsor pool cover this owner's storage?
  useEffect(() => {
    if (!session) return;
    setSpons(undefined);
    getSponsorship(session.accountId)
      .then(setSpons)
      .catch(() => setSpons(null));
  }, [session]);
  // Keep an unsent new-plan draft for this tab.
  useEffect(() => {
    if (existing !== null) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {}
  }, [d, existing]);

  const owner = session?.accountId ?? "";
  // D25: Ethereum and Bitcoin destinations belong to the Standard tier. A heir named by email gets the
  // Ethereum address kept for them only when the owner's tier already covers it, so naming one person
  // by email on a Free plan stays free (they receive NEAR).
  const extOk = !tierCfg?.fee_token || !!tierCfg.tiers[tier ? Math.max(tier.tier, editing ? tier.required : 0) : 0]?.external_assets;
  const plan: PlanInput = useMemo(
    () => ({
      check_in_interval_ms: toMs(d.checkIn),
      grace_ms: toMs(d.grace),
      waiting_period_ms: toMs(d.waiting),
      // An email stands for the account kept for it (empty until it has one: the plan can't be signed before).
      guardians: d.guardians.map((g) => accountOf(g, d.emails)).filter(Boolean),
      quorum: Number(d.quorum) || 0,
      heirs: d.heirs.map((h) => {
        const mail = d.emails[h.account.trim().toLowerCase()];
        const id = accountOf(h.account, d.emails);
        return {
          account_id: id,
          share_bps: Math.round(Number(h.pct) * 100) || 0,
          // Named by email: NEAR goes to the NEAR account kept for the address, ETH to its Ethereum one.
          near_destination: h.near.trim().toLowerCase() || mail?.near || id || null,
          eth_destination: h.eth.trim() ? h.eth.trim().toLowerCase() : mail && extOk ? mail.account : null,
        };
      }),
    }),
    [d, extOk],
  );
  // Ethereum wallets can't attach NEAR: no deposit, and storage must be sponsored.
  const evm = session?.kind === "evm";
  const sponsored = !!session?.canSponsorStorage && sponsorshipAvailable(spons ?? null, !editing);
  const evmBlocked = evm && spons !== undefined && !sponsored;
  let depositYocto: bigint | null = null;
  try {
    depositYocto = evm ? 0n : parseNear(d.deposit || "0");
  } catch {}

  // An empty row asks for an email where email is on: most people an owner names have an inbox, not a wallet.
  const defaultKind: PersonKind = emailOn ? "email" : "account";
  const guardianKinds = d.guardians.map((g, i) => kindOf(g, d.guardianBy?.[i], defaultKind));
  const errs: Record<WizardStep, FieldErrors> = {
    start: d.preset ? {} : { preset: "Pick a starting point, or start from scratch." },
    timing: timingErrors(d, demo),
    guardians: guardianErrors(d.guardians, d.quorum, owner, d.emails, d.noticeEmails, guardianKinds),
    heirs: heirErrors(d.heirs, owner, d.guardians, d.emails, defaultKind),
    funding: depositYocto === null ? { deposit: "Not a valid NEAR amount." } : {},
    review: {},
  };
  const safetyCalls: { method: string; args: Record<string, unknown>; summary: string }[] = [
    // Guardian settings first: once the edit notice is on, they'd wait it out.
    ...(d.availability > 0 ? [{ method: "set_guardian_settings", args: { settings: { standbys: [], availability_ms: d.availability, swap_delay_ms: d.swapDelay } }, summary: "Turn on guardian availability checks" }] : []),
    ...(d.notice > 0 ? [{ method: "set_edit_notice", args: { notice_ms: d.notice }, summary: `Set a ${duration(d.notice)} edit notice` }] : []),
  ];
  const summaryInput = {
    plan,
    rules: extras.rules,
    options: extras.options,
    notice: editing ? editNotice : d.notice,
    guardianSettings: editing ? null : d.availability > 0 ? { standbys: [], availability_ms: d.availability, swap_delay_ms: d.swapDelay } : null,
    btcDestinations: extras.btc,
    intents: intentsDeliveries(d.heirs).length,
    delegates: extras.delegates,
    sealed: d.privacy === "private" ? { count: plan.heirs.length, reveal_window_ms: d.revealWindow, unrevealed: d.unrevealed, backup: d.backup } : null,
    demo,
  };
  const show = (s: WizardStep) => (tried[s] ? errs[s] : {});
  const stepOk = (s: WizardStep) => Object.keys(errs[s]).length === 0;
  const finalErrors = session ? validateDraft(plan, session.accountId) : [];
  // D25: the tier this draft needs, and whether the owner has it (or already uses it).
  const tiersOn = !!tierCfg?.fee_token;
  const priv = d.privacy === "private";
  const deliveries = priv ? [] : intentsDeliveries(d.heirs);
  const baseFeatures = features(plan, extras.rules, extras.options, extras.btc, extras.tokens, extras.delegates, deliveries.length > 0);
  // D33: a sealed plan's hidden destinations may be external.
  const draftFeatures = { ...baseFeatures, guardians: baseFeatures.guardians + extras.standbys, external_assets: baseFeatures.external_assets || priv };
  const needTier = tierCfg && tiersOn ? requiredTier(tierCfg, draftFeatures) : 0;
  const allowance = tier ? Math.max(tier.tier, editing ? tier.required : 0) : 0;
  const tierBlocked = tiersOn && (!tier || needTier > allowance);
  const idx = steps.indexOf(step);

  const go = (to: WizardStep) => {
    setDir(steps.indexOf(to) >= idx ? 1 : -1);
    setStep(to);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const focusInvalid = () => requestAnimationFrame(() => (document.querySelector("[aria-invalid=true]") as HTMLElement | null)?.focus());
  /** Emails typed for guardians or heirs that have no account yet. */
  const pendingEmails = unresolvedEmails([...d.guardians, ...d.heirs.map((h) => h.account)], d.emails);

  /**
   * Gives every typed email its account (the notifier asks Privy for the wallets
   * kept for that address). Returns the full map, or null if it couldn't be done.
   */
  async function resolveEmails(): Promise<EmailAccounts | null> {
    if (!session) return null;
    const todo: { email: string; role: PersonRole; label?: string }[] = [
      ...d.guardians.map((g) => ({ email: g.trim().toLowerCase(), role: "guardian" as const })),
      ...d.heirs.map((h) => ({ email: h.account.trim().toLowerCase(), role: "heir" as const, label: h.label?.trim() || undefined })),
    ].filter((x, i, all) => looksLikeEmail(x.email) && !d.emails[x.email] && all.findIndex((y) => y.email === x.email) === i);
    if (!todo.length) return d.emails;
    setResolving(true);
    setError(null);
    try {
      const found: EmailAccounts = {};
      for (const t of todo) {
        const p = await namePerson(session, { ...t, announce: t.role === "heir" ? d.tellHeirs : true, name: d.ownerName.trim() || undefined });
        found[t.email] = { account: p.account, near: p.near ?? "", btc: p.btc ?? "" };
      }
      const all = { ...d.emails, ...found };
      setD((x) => ({ ...x, emails: { ...x.emails, ...found } }));
      return all;
    } catch (e) {
      setError(peopleError(e));
      return null;
    } finally {
      setResolving(false);
    }
  }
  // Reaching the review another way (the stepper) still needs every email to have its account.
  useEffect(() => {
    if (step === "review" && pendingEmails.length && !resolving && !error) void resolveEmails();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = async (e?: FormEvent) => {
    e?.preventDefault();
    if (resolving) return;
    setTried((t) => ({ ...t, [step]: true }));
    if (!stepOk(step)) return focusInvalid();
    if (step === "guardians" || step === "heirs") {
      const emails = await resolveEmails();
      if (!emails) return;
      // An address can turn out to be the owner's own, or someone already listed by account.
      const after = step === "guardians" ? guardianErrors(d.guardians, d.quorum, owner, emails, d.noticeEmails, guardianKinds) : heirErrors(d.heirs, owner, d.guardians, emails, defaultKind);
      if (Object.keys(after).length) return focusInvalid();
    }
    const n = steps[idx + 1];
    if (n) go(n);
  };
  const reachable = (s: WizardStep) => steps.slice(0, steps.indexOf(s)).every(stepOk);

  /** Calls whose deposit only pays storage: sponsored when possible, else the owner pays (refunded beyond use). */
  async function storageCall(method: string, args: Record<string, unknown>, summary: string) {
    if (!session) return;
    if (sponsored || evm) {
      try {
        await session.call(method, args, { sponsor: true, summary });
        return;
      } catch (e) {
        if (evm || !(e instanceof SponsorRefused)) throw e;
      }
    }
    await session.call(method, args, { deposit: INTENTS_DEPOSIT, summary });
  }

  /**
   * Brings the notifier's list of named people in line with what was just signed:
   * names, who gets told now, and addresses for people named by account. The
   * plan is already saved, so a failure here only delays their emails.
   */
  async function syncPeople(): Promise<boolean> {
    if (!session) return true;
    const name = d.ownerName.trim() || undefined;
    const jobs: Parameters<typeof namePerson>[1][] = [];
    for (const g of d.guardians) {
      const e = g.trim().toLowerCase();
      if (looksLikeEmail(e)) jobs.push({ email: e, role: "guardian", name });
      else if (e && d.noticeEmails[e]?.trim()) jobs.push({ email: d.noticeEmails[e]!, role: "guardian", account: e, name });
    }
    for (const h of d.heirs) {
      const e = h.account.trim().toLowerCase();
      const label = h.label?.trim() || undefined;
      if (looksLikeEmail(e)) jobs.push({ email: e, role: "heir", label, announce: d.tellHeirs, name });
      else if (e && h.noticeEmail?.trim()) jobs.push({ email: h.noticeEmail, role: "heir", account: e, label, announce: d.tellHeirs, name });
    }
    if (!jobs.length) return true;
    try {
      for (const j of jobs) await namePerson(session, j);
      const told = jobs.filter((j) => j.role !== "heir" || j.announce).length;
      setPeopleNote(told ? `We'll email ${told === 1 ? "the person" : `the ${told} people`} you chose to tell within a minute or two.` : null);
      return true;
    } catch (e) {
      setPeopleNote(`Your plan is saved, but the emails couldn't be set up (${peopleError(e)}). Edit the plan and save again to retry.`);
      return false;
    }
  }

  async function submit() {
    if (!session) return;
    setError(null);
    // Nothing is signed while an email still has no account behind it.
    if (pendingEmails.length && !(await resolveEmails())) return;
    try {
      setPhase("plan");
      // D26: a DAO saves the plan and its first deposit in one proposal (one vote), paying its own storage.
      // D33: records (salts kept for unchanged heirs) and their commitments, computed here.
      const records: HeirRecord[] = priv
        ? plan.heirs.map((h, i) => ({ account_id: h.account_id, share_bps: h.share_bps, near_destination: h.near_destination, eth_destination: h.eth_destination, btc_destination: d.heirs[i]?.btc?.trim() || d.emails[d.heirs[i]?.account.trim().toLowerCase() ?? ""]?.btc || null, salt: d.heirs[i]?.salt || crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "") }))
        : [];
      const sealed = priv ? { commitments: await Promise.all(records.map((r) => commitment(owner, r))), reveal_window_ms: d.revealWindow, unrevealed: d.unrevealed } : null;
      const saveMethod = priv ? "set_private_plan" : "set_plan";
      const saveArgs: Record<string, unknown> = priv ? { plan: { ...plan, heirs: [] }, sealed } : { plan };
      if (priv) {
        saveLocalRecords(owner, records);
        setMadeRecords(records);
        // A sealed plan can't keep heir-specific Bitcoin destinations or Intents delivery.
        if (extras.btc > 0) await storageCall("set_btc_destinations", { destinations: [] }, "Clear Bitcoin destinations (they move into private records)");
        if (savedIntents.length) await storageCall("set_intents_delivery", { deliveries: [] }, "Stop NEAR Intents delivery (not available for private heirs)");
      }
      if (session.propose) {
        const calls: DaoCall[] = [{ method: saveMethod, args: saveArgs, deposit: 100_000_000_000_000_000_000_000n }];
        if (!editing) for (const c of safetyCalls) calls.push({ method: c.method, args: c.args, deposit: INTENTS_DEPOSIT });
        if (deliveries.length || savedIntents.length) calls.push({ method: "set_intents_delivery", args: { deliveries }, deposit: INTENTS_DEPOSIT });
        if (!editing && depositYocto && depositYocto > 0n) calls.push({ method: "deposit", args: { owner: session.accountId }, deposit: depositYocto });
        const r = await session.propose(calls);
        setProposed(r.proposalId ?? null);
        setPhase("done");
        try {
          sessionStorage.removeItem(DRAFT_KEY);
        } catch {}
        return;
      }
      let saved = false;
      // D24: no deposit, Behest's sponsor pool pays the storage. If the relayer
      // or the pool says no, a NEAR account pays as before (nothing changed yet).
      if (sponsored || evm) {
        try {
          await session.call(saveMethod, saveArgs, { sponsor: true, summary: priv ? (editing ? "Update your private inheritance plan" : "Create a private inheritance plan") : editing ? "Update your inheritance plan" : "Create your inheritance plan" });
          saved = true;
          setPaidBy("behest");
        } catch (e) {
          if (evm || !(e instanceof SponsorRefused)) throw e;
        }
      }
      // Storage deposit; the contract refunds whatever it doesn't use.
      if (!saved) {
        await session.call(saveMethod, saveArgs, { deposit: 100_000_000_000_000_000_000_000n });
        setPaidBy("you");
      }
      // D28: big edits are queued. Say so; the plan screen shows them with a countdown.
      const queued = editing && editNotice > 0 ? await viewCall<{ effective_at_ms: number }[]>("get_pending_changes", { owner: session.accountId }).catch(() => []) : [];
      if (queued.length) setQueuedNote(`Your changes to heirs, guardians or quorum take effect when your edit notice ends (${duration(editNotice)}). Your guardians and heirs have been told, and you can cancel from the plan screen until then.`);
      // D33: Behest's encrypted copy, if the owner chose it (checked against the plan on-chain, so not while queued).
      if (priv && d.backup) {
        if (queued.length) setBackupNote("Back up the records from your plan page once the change has taken effect.");
        else
          await backupRecords(session, records).then(
            () => setBackupNote("Behest keeps an encrypted copy. Each heir can get theirs once you're overdue."),
            (e) => setBackupNote(`The backup didn't go through (${humanError(e)}). Try again from your plan page.`),
          );
      }
      // Preset safety settings (new plans): D28 edit notice, D29 availability checks.
      if (!editing) for (const c of safetyCalls) await storageCall(c.method, c.args, c.summary);
      // D27: who receives through NEAR Intents (after set_plan: only the plan's recipients may opt in).
      try {
        if (deliveries.length || savedIntents.length) {
          const summary = deliveries.length ? "Choose who receives through NEAR Intents" : "Stop paying heirs through NEAR Intents";
          let done = false;
          if (sponsored || evm) {
            try {
              await session.call("set_intents_delivery", { deliveries }, { sponsor: true, summary });
              done = true;
            } catch (e) {
              if (evm || !(e instanceof SponsorRefused)) throw e;
            }
          }
          if (!done) await session.call("set_intents_delivery", { deliveries }, { deposit: INTENTS_DEPOSIT, summary });
        }
      } catch (e) {
        // A new heir isn't a recipient until the queued plan change lands.
        if (!queued.length) throw e;
        setQueuedNote((n) => `${n ?? ""} Save the NEAR Intents choices again once it has taken effect.`);
      }
      const peopleOk = await syncPeople();
      if (!editing && depositYocto && depositYocto > 0n) {
        setPhase("deposit");
        await session.call("deposit", { owner: session.accountId }, { deposit: depositYocto });
      }
      setPhase("done");
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {}
      if (!queued.length && !priv && peopleOk) setTimeout(() => router.push(`/plan/${encodeURIComponent(session.accountId)}`), 1400);
    } catch (e) {
      setError(humanError(e));
      setPhase("idle");
    }
  }

  if (ready && !session) {
    return (
      <AppShell>
        <EmptyState icon={UserRound} title="Sign in to create a plan" body="The account you sign in with becomes the plan owner. No wallet? Try every role with test personas.">
          <Button variant="primary" onClick={() => setSignIn(true)}>
            Sign in
          </Button>
          <ButtonLink href="/try" variant="outline">
            Try as a test persona
          </ButtonLink>
        </EmptyState>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </AppShell>
    );
  }
  if (loadFailed) {
    return (
      <AppShell>
        <EmptyState icon={WifiOff} tone="error" title="Couldn't read your current plan" body="The NEAR network didn't answer. Behest needs to know whether you already have a plan before you edit or create one.">
          <Button variant="ink" icon={RotateCcw} onClick={() => setLoadTry((n) => n + 1)}>
            Try again
          </Button>
        </EmptyState>
      </AppShell>
    );
  }
  if (!ready || existing === undefined) {
    return (
      <AppShell>
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-14 w-full rounded-tile" />
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
      </AppShell>
    );
  }

  if (phase === "done") {
    return (
      <AppShell narrow>
        <div className="flex flex-col items-center gap-5 py-16 text-center">
          <span className="flex size-20 animate-pop items-center justify-center rounded-full bg-ok-bg text-ok">
            <CircleCheck aria-hidden className="size-10" />
          </span>
          <h1 className="text-[clamp(32px,6vw,48px)] font-medium leading-none tracking-[-0.04em]">{proposed !== undefined ? "Proposed to the DAO." : queuedNote ? "Changes requested." : editing ? "Plan updated." : "Your plan is live."}</h1>
          {proposed !== undefined ? (
            <p role="status" className="max-w-[460px] text-lg text-muted">
              {proposed !== null ? `Proposal #${proposed}` : "The proposal"} {editing ? "updates" : "creates"} the plan once {owner}&apos;s council approves it. Vote on it from the plan page or your DAO app.
            </p>
          ) : (
            <p role="status" className="max-w-[420px] text-lg text-muted">
              {queuedNote ?? <>{madeRecords ? "Save the records below before you leave. " : "Taking you to it now. "}{paidBy === "behest" ? "Behest covered the plan's storage. " : ""}Remember to check in every {duration(plan.check_in_interval_ms)}.</>}
            </p>
          )}
          {peopleNote && <p className="max-w-[420px] text-[15px] text-muted">{peopleNote}</p>}
          {madeRecords && <RecordsDownload owner={owner} records={madeRecords} note={backupNote} />}
          <ButtonLink href={`/plan/${encodeURIComponent(owner)}`} variant="primary" iconRight={ArrowRight}>
            {proposed !== undefined ? "Go to the proposals" : "Open your plan"}
          </ButtonLink>
        </div>
      </AppShell>
    );
  }

  const meta = STEP_META[step];
  const signing = phase !== "idle";
  // Before a starting point is picked, and for any timer left blank, the summary says "not set" instead of a number nobody chose.
  const blank = (t: TimerDraft) => !d.preset || t.n.trim() === "";
  const unset = { checkIn: blank(d.checkIn), grace: blank(d.grace), waiting: blank(d.waiting) };
  const anyUnset = unset.checkIn || unset.grace || unset.waiting;
  return (
    <AppShell mainClassName="max-w-[1180px]">
      <div ref={top} className="scroll-mt-24 flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted">{editing ? "Edit your plan" : "Create a plan"}</span>
        <h1 className="text-[clamp(32px,5vw,52px)] font-medium leading-[0.95] tracking-[-0.045em]">{meta.title}</h1>
        <p className="max-w-[680px] text-[17px] leading-relaxed text-muted">{evm && step === "funding" ? "Your plan's Ethereum and Bitcoin vaults appear on your plan page once it's saved. Fund them by sending to their addresses." : meta.lede}</p>
      </div>

      <Stepper steps={steps} current={step} ok={stepOk} reachable={reachable} onGo={go} />

      <DaoBanner />
      <DaoSetupNotes step={step} intervalMs={plan.check_in_interval_ms} heirs={plan.heirs.map((h) => h.account_id)} mode={extras.options?.mode ?? null} />

      {editing && existing && step === steps[0] && <Notice tone="info">Your current plan is filled in. Saving makes a new version, which counts as a check-in; any open release must be cancelled first.</Notice>}

      {/* The review step is the whole plan already, so the "so far" sidebar steps aside there. */}
      <div className={cx("grid grid-cols-1 items-start gap-6", step !== "review" && "lg:grid-cols-[minmax(0,1fr)_340px]")}>
        <form onSubmit={step === "review" ? (e) => e.preventDefault() : next} noValidate className="flex min-w-0 flex-col gap-4">
          <Swap id={step} dir={dir} className="flex flex-col gap-4">
            {step === "start" && <StartStep d={d} setD={setD} demo={demo} error={show("start").preset} />}
            {step === "timing" && <TimingStep d={d} set={set} demo={demo} errors={show("timing")} editing={editing} />}
            {step === "guardians" && <GuardianStep d={d} set={set} errors={show("guardians")} demo={demo} editing={editing} emailOn={emailOn} owner={owner} />}
            {step === "heirs" && <HeirStep d={d} set={set} errors={show("heirs")} intents={!!intentsCfg && !priv} demo={demo} fallback={!!extras.rules?.fallback} sealedInfo={sealedInfo} emailOn={emailOn} extOk={extOk} />}
            {step === "funding" && <FundingStep d={d} set={set} errors={show("funding")} evm={evm} sponsored={sponsored} />}
            {step === "review" && session && (
              <ReviewStep summaryInput={summaryInput} plan={plan} d={d} owner={owner} editing={editing} depositYocto={depositYocto} onEdit={go} finalErrors={finalErrors} ack={ack} setAck={setAck} evm={evm} sponsored={sponsored} spons={spons} />
            )}
          </Swap>

          {step === "review" && tiersOn && tierCfg && tier && needTier > allowance && (
            <TierNeeded cfg={tierCfg} owner={owner} need={needTier} tier={tier} onPaid={reloadTier} reason={reasonFor(tierCfg, allowance, draftFeatures)} />
          )}
          {error && (
            <Notice tone="error" title="Nothing was saved">
              {error}
            </Notice>
          )}
          {step === "review" && pendingEmails.length > 0 && !resolving && (
            <Notice tone="warn" title="Some people don't have an account yet" action={<Button type="button" size="sm" variant="outline" onClick={() => void resolveEmails()}>Try again</Button>}>
              {pendingEmails.join(", ")}: each email address needs the account that will hold their share before you can sign.
            </Notice>
          )}
          {signing && <SigningProgress phase={phase} withDeposit={!editing && !!depositYocto && depositYocto > 0n} evm={evm} />}

          <div className="sticky bottom-[calc(68px+env(safe-area-inset-bottom))] z-10 -mx-4 flex items-center justify-between gap-2 border-t border-line bg-paper/90 px-4 py-3 backdrop-blur-md sm:-mx-0 sm:rounded-row sm:border sm:px-3 lg:bottom-2">
            <Button type="button" variant="ghost" icon={ArrowLeft} disabled={idx === 0 || signing} onClick={() => go(steps[idx - 1]!)}>
              Back
            </Button>
            <span className="hidden text-sm text-muted sm:block">
              Step {idx + 1} of {steps.length}
            </span>
            {step !== "review" ? (
              <Button type="submit" variant="ink" iconRight={ArrowRight} loading={resolving}>
                {resolving ? "Setting up their accounts" : "Continue"}
              </Button>
            ) : (
              <Button type="button" variant="primary" icon={Check} loading={signing} disabled={finalErrors.length > 0 || pendingEmails.length > 0 || resolving || !ack || tierBlocked || (!editing && depositYocto === null) || evmBlocked || (evm && spons === undefined)} onClick={submit}>
                {editing ? "Sign and update" : "Sign and create"}
              </Button>
            )}
          </div>
        </form>

        <aside className={cx("hidden flex-col gap-3 lg:sticky lg:top-2", step !== "review" && "lg:flex")}>
          <Card className="flex flex-col gap-4">
            <span className="text-sm font-semibold text-muted">Your plan so far</span>
            <p className={cx("text-[15px] leading-relaxed", anyUnset && "text-muted")}>
              {anyUnset ? (d.preset ? "Starting from scratch: set your timers in the next step and the plan is spelled out here." : "Pick a starting point and the plan is spelled out here.") : session ? describePlan(plan) : ""}
            </p>
            <Consequences plan={plan} unset={unset} />
            {d.preset && d.preset !== "custom" && !editing && <PresetBadge d={d} demo={demo} />}
            {!anyUnset && <AsideWarnings input={summaryInput} />}
            {tiersOn && tierCfg && (
              <span className="flex items-center justify-between gap-2 rounded-row bg-subtle px-3 py-2 text-sm">
                <span>
                  <span className="font-semibold">{tierCfg.tiers[needTier]!.name}</span> tier
                </span>
                <span className="text-muted">{needTier <= allowance ? (tier && tier.tier > 0 ? "paid" : "free") : `${formatUsd(tierCfg.tiers[needTier]!.price, tierCfg.fee_decimals)} once`}</span>
              </span>
            )}
            {plan.heirs.length > 0 && <ShareBar heirs={plan.heirs} />}
          </Card>
          <p className="px-2 text-xs leading-relaxed text-muted">Your draft stays in this tab until you sign. Nothing is sent before the review step.</p>
        </aside>
      </div>
    </AppShell>
  );
}

// ------------------------------------------------------------------ privacy (D33)

function revealChoices(demo: boolean, cur: number) {
  return [...new Set([...(demo ? [2 * MIN_MS, 5 * MIN_MS, 30 * MIN_MS] : []), 7 * DAY_MS, 30 * DAY_MS, 90 * DAY_MS, cur])].sort((a, b) => a - b);
}

function PrivacyCard({ d, set, demo, fallback, sealedInfo }: { d: Draft; set: SetFn; demo: boolean; fallback: boolean; sealedInfo: { count: number; known: number } | null }) {
  const priv = d.privacy === "private";
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle title="Who can see your heirs?" sub="Private keeps who inherits, how much and where off the public record until you're overdue. Each heir then reveals their own recovery record." />
      <Segmented
        label="Privacy"
        value={d.privacy}
        onChange={(v) => set("privacy", v)}
        options={[
          { value: "public", label: "Public" },
          { value: "private", label: "Private" },
        ]}
      />
      {sealedInfo && sealedInfo.known < sealedInfo.count && (
        <Notice tone="warn" title={`This browser has ${sealedInfo.known} of your ${sealedInfo.count} heir records`}>
          Enter your heirs again to save a new private plan: their old records will stop working, so hand out the new ones. Or restore the records on your plan page first.
        </Notice>
      )}
      {priv ? (
        <>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed">
            <li>On-chain there&apos;s only a fingerprint per heir. Nobody can read who or how much.</li>
            <li>Each heir needs a recovery record file to claim. You&apos;ll download one per heir to pass on; their printed packet has it too.</li>
            <li>Once you&apos;re overdue, heirs reveal their records; if you check in again, everything is hidden again.</li>
            <li>Payments themselves are public on every chain once they happen. Standard plan or above.</li>
          </ul>
          <Field label="Reveal window" hint="After you become overdue, how long a release waits for every heir to reveal.">
            {() => <Segmented label="Reveal window" value={String(d.revealWindow)} onChange={(v) => set("revealWindow", Number(v))} options={revealChoices(demo, d.revealWindow).map((ms) => ({ value: String(ms), label: duration(ms) }))} />}
          </Field>
          {fallback ? (
            <Field label="If a heir never reveals" hint="Choose where their share goes.">
              {() => (
                <Segmented
                  label="If a heir never reveals"
                  value={d.unrevealed}
                  onChange={(v) => set("unrevealed", v)}
                  options={[
                    { value: "Redistribute", label: "Split among the others" },
                    { value: "Fallback", label: "To your fallback" },
                  ]}
                />
              )}
            </Field>
          ) : (
            // One outcome is not a choice: say it as a fact, not as a lone button.
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold">If a heir never reveals</span>
              <p className="text-sm leading-relaxed text-muted">Their share is split among the other heirs. To send it to one person instead, add a fallback recipient on your plan page after saving.</p>
            </div>
          )}
          <Field label="Backup" hint={d.backup ? "Behest stores the records encrypted and gives each heir theirs only once you're overdue. Behest itself could read them." : "Only you and your heirs hold the records. If one is lost, that share follows the rule above."}>
            {() => (
              <Segmented
                label="Backup"
                value={d.backup ? "behest" : "self"}
                onChange={(v) => set("backup", v === "behest")}
                options={[
                  { value: "self", label: "Only me and my heirs" },
                  { value: "behest", label: "Behest keeps a copy" },
                ]}
              />
            )}
          </Field>
        </>
      ) : (
        <p className="text-sm text-muted">Anyone can read your heirs, shares and addresses on-chain. Easiest to check, least private.</p>
      )}
    </Card>
  );
}

function RecordsDownload({ owner, records, note }: { owner: string; records: HeirRecord[]; note: string | null }) {
  return (
    <Card className="flex w-full max-w-[560px] flex-col gap-3 text-left">
      <SectionTitle title="Save your heirs' recovery records now" sub="Without its record, a heir can't be revealed. Give each heir theirs; their printed packet has it too." />
      <ul className="flex flex-col gap-2">
        {records.map((r) => (
          <li key={r.account_id} className="flex items-center justify-between gap-2 rounded-row bg-subtle px-3 py-2">
            <span className="text-sm">
              {shortName(r.account_id)} · {r.share_bps / 100}%
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => downloadJson(`behest-record-${r.account_id}.json`, recordFile(owner, r))}>
              Download
            </Button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="ink" className="self-start" onClick={() => downloadJson(`behest-records-${owner}.json`, records.map((r) => recordFile(owner, r)))}>
        Download all
      </Button>
      <p className="text-sm text-muted">This browser keeps a copy too. {note}</p>
    </Card>
  );
}

// ------------------------------------------------------------------ presets

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
function noticeChoices(demo: boolean, cur: number) {
  const days = [1, 3, 7, 14, 30].map((n) => n * DAY_MS);
  return [...new Set([0, ...(demo ? [MIN_MS, 2 * MIN_MS, 10 * MIN_MS] : []), ...days, cur])].sort((a, b) => a - b);
}
function availabilityChoices(demo: boolean, cur: number) {
  return [...new Set([0, ...(demo ? [10 * MIN_MS, 30 * MIN_MS] : []), 30 * DAY_MS, 90 * DAY_MS, 180 * DAY_MS, cur])].sort((a, b) => a - b);
}

/** A preset's length in the wizard's own units: whole months (30 days each) where it divides, else as usual. */
const span = (ms: number) => (ms > 0 && ms % UNIT_MS.months === 0 ? `${ms / UNIT_MS.months} month${ms === UNIT_MS.months ? "" : "s"}` : duration(ms));

const PRESET_ROWS: { k: "checkIn" | "grace" | "waiting" | "quorum" | "notice" | "availability"; label: string; value: (v: ReturnType<typeof presetValues>) => string; means: (v: ReturnType<typeof presetValues>) => string }[] = [
  { k: "checkIn", label: "Check in every", value: (v) => span(v.checkIn), means: (v) => `Miss it and, after the grace period, the plan is overdue.` },
  { k: "grace", label: "Grace", value: (v) => (v.grace ? span(v.grace) : "none"), means: (v) => (v.grace ? `${span(v.grace)} extra before guardians can act.` : "Guardians can act the moment a check-in is missed.") },
  { k: "quorum", label: "Guardians", value: (v) => `${v.quorum} of ${v.guardians}`, means: () => "One guardian can be away or lost without blocking the release." },
  { k: "waiting", label: "Waiting period", value: (v) => span(v.waiting), means: (v) => `${span(v.waiting)} to cancel a release you didn't expect.` },
  { k: "notice", label: "Edit notice", value: (v) => (v.notice ? span(v.notice) : "off"), means: (v) => (v.notice ? `A stolen key can't redirect funds for ${span(v.notice)}; guardians and heirs are told.` : "Edits apply at once.") },
  { k: "availability", label: "Availability checks", value: (v) => (v.availability ? `every ${span(v.availability)}` : "off"), means: (v) => (v.availability ? "You're told when a guardian goes quiet." : "Nobody checks guardians are still around.") },
];

/** "Start from scratch" clears what a preset (or the built-in default) filled in, so every value really is the user's own. */
function scratch(demo: boolean): Pick<Draft, "checkIn" | "grace" | "waiting" | "notice" | "availability"> {
  const unit: Unit = demo ? "minutes" : "days";
  return { checkIn: { n: "", unit }, grace: { n: "", unit }, waiting: { n: "", unit }, notice: 0, availability: 0 };
}

/** The round marker that says "this is a choice": empty until picked, then filled with a tick. */
function RadioDot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cx("flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors", on ? "border-signal bg-signal text-white" : "border-line-strong bg-card group-hover:border-signal")}>
      {on && <Check className="size-3.5 animate-pop" strokeWidth={3} />}
    </span>
  );
}

/** The three timers are what tell the presets apart at a glance; the rest sits in the details. */
const CARD_ROWS = ["checkIn", "grace", "waiting"];

function StartStep({ d, setD, demo, error }: { d: Draft; setD: (f: (x: Draft) => Draft) => void; demo: boolean; error?: string }) {
  return (
    <>
      <div role="radiogroup" aria-label="Starting point" className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {PRESETS.map((p) => {
          const v = demo ? p.demo : p.prod;
          const on = d.preset === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setD((x) => ({ ...applyPreset(x, p.id, demo), preset: p.id }))}
              className={cx("group flex cursor-pointer flex-col gap-3 rounded-card border p-4 text-left transition-[background-color,border-color,box-shadow,transform] duration-150", on ? "border-signal bg-s-approved/40 ring-2 ring-signal" : "border-line-strong bg-card hover:-translate-y-0.5 hover:border-signal hover:shadow-float")}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-lg font-semibold">{p.name}</span>
                  <span className="text-sm text-muted">{p.tagline}</span>
                </span>
                <RadioDot on={on} />
              </span>
              <dl className="flex flex-col gap-1 text-sm">
                {PRESET_ROWS.filter((r) => CARD_ROWS.includes(r.k)).map((r) => (
                  <div key={r.k} className="flex justify-between gap-2">
                    <dt className="text-muted">{r.label}</dt>
                    <dd className="tabular text-right font-medium">{r.value(v)}</dd>
                  </div>
                ))}
              </dl>
              <span className="text-sm text-muted">{p.forWhom}</span>
              <span className={cx("mt-auto border-t border-line pt-3 text-sm font-semibold", on ? "text-signal-text" : "text-ink group-hover:text-signal-text")}>{on ? "Selected" : `Choose ${p.name}`}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="radio"
        aria-checked={d.preset === "custom"}
        onClick={() => setD((x) => (x.preset === "custom" ? x : { ...x, ...scratch(demo), preset: "custom" }))}
        className={cx("flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-row border px-4 py-3 text-left text-[15px] transition-colors", d.preset === "custom" ? "border-signal bg-s-approved/40 ring-2 ring-signal" : "border-line-strong bg-card hover:border-signal")}
      >
        <span>
          <span className="font-semibold">Start from scratch.</span> <span className="text-muted">Set every value yourself.</span>
        </span>
        <RadioDot on={d.preset === "custom"} />
      </button>
      {error && <span className="text-[13px] font-semibold text-error">{error}</span>}
      {d.preset && d.preset !== "custom" && (
        <Disclosure title={`Everything ${PRESETS.find((p) => p.id === d.preset)!.name} sets`} sub="All of it stays editable.">
          <dl className="flex flex-col divide-y divide-line">
            {PRESET_ROWS.map((r) => {
              const v = presetValues(d.preset as PresetId, demo);
              return (
                <div key={r.k} className="grid gap-1 py-2 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
                  <dt className="text-sm font-semibold">
                    {r.label} · {r.value(v)}
                  </dt>
                  <dd className="text-sm text-muted">{r.means(v)}</dd>
                </div>
              );
            })}
            <div className="grid gap-1 py-2 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-semibold">Heirs claim</dt>
              <dd className="text-sm text-muted">Each heir claims their own share. More release options are on your plan page after saving.</dd>
            </div>
          </dl>
        </Disclosure>
      )}
    </>
  );
}

/** "Based on Balanced · edited: check-in, waiting period". */
function PresetBadge({ d, demo }: { d: Draft; demo: boolean }) {
  const id = d.preset as PresetId;
  const changed = editedFrom(
    { checkIn: toMs(d.checkIn), grace: toMs(d.grace), waiting: toMs(d.waiting), guardians: d.guardians.length, quorum: Number(d.quorum) || 0, notice: d.notice, availability: d.availability, swapDelay: d.swapDelay },
    id,
    demo,
  );
  const names: Record<string, string> = { checkIn: "check-in", grace: "grace", waiting: "waiting period", guardians: "guardian count", quorum: "approvals", notice: "edit notice", availability: "availability checks", swapDelay: "swap notice" };
  return (
    <span className="rounded-row bg-subtle px-3 py-2 text-sm">
      Based on <span className="font-semibold">{PRESETS.find((p) => p.id === id)!.name}</span>
      {changed.length ? <span className="text-muted"> · you changed {changed.map((k) => names[k]).join(", ")}</span> : <span className="text-muted"> · unchanged</span>}
    </span>
  );
}

function AsideWarnings({ input }: { input: Parameters<typeof planSummary>[0] }) {
  const w = planSummary(input).warnings.filter((x) => x.tone === "warn");
  if (!w.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-sm text-[var(--s-overdue-fg)]">
      {w.map((x) => (
        <li key={x.text}>· {x.text}</li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ stepper

function Stepper({ steps, current, ok, reachable, onGo }: { steps: WizardStep[]; current: WizardStep; ok: (s: WizardStep) => boolean; reachable: (s: WizardStep) => boolean; onGo: (s: WizardStep) => void }) {
  const at = steps.indexOf(current);
  return (
    <nav aria-label="Steps">
      <div className="mb-2 flex items-center justify-between text-sm sm:hidden">
        <span className="font-semibold">
          Step {at + 1} of {steps.length} · {STEP_META[current].label}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-line sm:hidden">
        <div className="h-full rounded-full bg-signal transition-[width] duration-500 ease-ledger" style={{ width: `${((at + 1) / steps.length) * 100}%` }} />
      </div>
      <ol className="hidden items-center gap-2 sm:flex">
        {steps.map((s, i) => {
          const I = STEP_META[s].icon;
          const done = i < at && ok(s);
          const on = s === current;
          const can = reachable(s);
          return (
            <li key={s} className="flex min-w-0 flex-1 items-center gap-2">
              <button
                type="button"
                disabled={!can && !on}
                onClick={() => onGo(s)}
                aria-current={on ? "step" : undefined}
                className={cx("flex min-h-11 min-w-0 items-center gap-2 rounded-full pr-3 text-sm transition-colors", on ? "font-semibold text-ink" : can ? "text-ink hover:bg-subtle" : "text-muted")}
              >
                <span
                  className={cx(
                    "flex size-9 shrink-0 items-center justify-center rounded-full transition-all duration-300 ease-ledger",
                    on ? "bg-ink text-ink-contrast" : done ? "bg-signal text-white" : "bg-card text-muted ring-1 ring-line-strong",
                  )}
                >
                  {done ? <Check aria-hidden className="size-4 animate-pop" /> : <I aria-hidden className="size-4" />}
                </span>
                <span className="truncate">{STEP_META[s].label}</span>
              </button>
              {i < steps.length - 1 && <span aria-hidden className={cx("h-0.5 min-w-3 flex-1 rounded-full transition-colors duration-500", i < at ? "bg-signal" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ------------------------------------------------------------------- steps

type SetFn = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

function TimerField({ label, tip, value, onChange, units, error, hint }: { label: string; tip: Parameters<typeof Field>[0]["tip"]; value: TimerDraft; onChange: (t: TimerDraft) => void; units: Unit[]; error?: string; hint: string }) {
  return (
    <Field label={label} tip={tip} hint={hint} error={error}>
      {(p) => (
        <div className="flex flex-wrap items-center gap-2">
          <input {...p} className={`${inputClass} w-28 text-lg font-semibold`} inputMode="decimal" value={value.n} onChange={(e) => onChange({ ...value, n: e.target.value })} />
          <Segmented label={`${label} unit`} size="sm" value={value.unit} onChange={(u) => onChange({ ...value, unit: u })} options={units.map((u) => ({ value: u, label: u }))} />
        </div>
      )}
    </Field>
  );
}

function TimingStep({ d, set, demo, errors, editing }: { d: Draft; set: SetFn; demo: boolean; errors: FieldErrors; editing: boolean }) {
  const units: Unit[] = demo ? ["minutes", "hours", "days", "months"] : ["days", "months"];
  return (
    <>
      <Card className="flex flex-col gap-6">
        <TimerField label="Check in every" tip="checkIn" value={d.checkIn} onChange={(t) => set("checkIn", t)} units={units} error={errors.checkIn} hint={`One tap, gas paid by Behest. Miss it and the grace period starts. ${demo ? "Up to" : "1 to"} 12 months.`} />
        <TimerField label="Then allow grace of" tip="grace" value={d.grace} onChange={(t) => set("grace", t)} units={units} error={errors.grace} hint={demo ? "Extra time before guardians can act, up to 1 month. Zero is fine for a demo." : "Extra time before guardians can act: 1 to 30 days."} />
        <TimerField label="Waiting period" tip="waiting" value={d.waiting} onChange={(t) => set("waiting", t)} units={units} error={errors.waiting} hint={`After guardians approve. You can still cancel during it. ${demo ? "Up to" : "7 days to"} 6 months.`} />
        <p className="text-sm text-muted">A month counts as 30 days.</p>
      </Card>
      {!editing && (
        <Card className="flex flex-col gap-3">
          <SectionTitle icon={Hourglass} title="Edit notice" sub="A delay before changes to your plan take effect. If someone steals your key and tries to change who inherits, the change waits this long and your guardians and heirs are told, so there is time to stop it. It covers changes to heirs, addresses, shares and guardians, including your own. Changing timers and withdrawing your funds stay instant." />
          <Segmented
            label="Edit notice"
            value={String(d.notice)}
            onChange={(v) => set("notice", Number(v))}
            options={noticeChoices(demo, d.notice).map((ms) => ({ value: String(ms), label: ms ? duration(ms) : "Off" }))}
          />
          <p className="text-sm text-muted">{d.notice ? `Changes wait ${duration(d.notice)} before they apply.` : "Changes apply as soon as you save them."}</p>
        </Card>
      )}
    </>
  );
}

/** The line under an email entry: what it means for that person, and the account once there is one. */
function emailHint(entry: string, emails: EmailAccounts, role: "guardian" | "heir") {
  const mail = emails[entry.trim().toLowerCase()];
  const what = role === "heir" ? "They sign in with this address and need no wallet. Their share arrives in the account kept for it." : "They sign in with this address and need no wallet.";
  return mail ? `${what} Account ${shortAddr(mail.account)}.` : what;
}

/** The two ways to name a person. Two choices read faster side by side than behind a menu. */
const KIND_OPTIONS = [
  { value: "email" as const, label: "Email", icon: Mail },
  { value: "account" as const, label: "Wallet account", icon: Wallet },
];

function GuardianStep({ d, set, errors, demo, editing, emailOn, owner }: { d: Draft; set: SetFn; errors: FieldErrors; demo: boolean; editing: boolean; emailOn: boolean; owner: string }) {
  const filled = d.guardians.filter((g) => g.trim()).length;
  const max = Math.max(1, filled);
  const q = Math.min(Number(d.quorum) || 1, max);
  const fallback: PersonKind = emailOn ? "email" : "account";
  const kinds = d.guardians.map((g, i) => kindOf(g, d.guardianBy?.[i], fallback));
  const anyEmail = kinds.some((k, i) => k === "email" || d.noticeEmails[d.guardians[i]!.trim().toLowerCase()]?.trim()) || d.heirs.some((h) => kindOf(h.account, h.by, fallback) === "email" || h.noticeEmail?.trim());
  const setGuardian = (i: number, v: string) => set("guardians", d.guardians.map((x, j) => (j === i ? v : x)));
  /** Switching how a guardian is named starts that row again: an address is not an account. */
  const setKind = (i: number, k: PersonKind) => {
    if (kinds[i] === k) return;
    set("guardianBy", d.guardians.map((_, j) => (j === i ? k : kinds[j])));
    setGuardian(i, "");
  };
  const remove = (i: number) => {
    set("guardians", d.guardians.filter((_, j) => j !== i));
    set("guardianBy", kinds.filter((_, j) => j !== i));
  };
  const add = () => {
    set("guardians", [...d.guardians, ""]);
    set("guardianBy", [...kinds, fallback]);
  };
  return (
    <>
      <Card className="flex flex-col gap-4">
        <SectionTitle
          icon={ShieldCheck}
          title={<Term k="guardian">Guardians</Term>}
          sub={emailOn ? "Two or three people who know you well is typical. Name each by their email, or by a wallet account they already use." : "NEAR accounts. Two or three people who know you well is typical."}
        />
        <ul className="flex flex-col gap-3">
          {d.guardians.map((g, i) => {
            const typed = g.trim().toLowerCase();
            const mail = kinds[i] === "email";
            return (
              <li key={i} className="flex animate-fade-up flex-col gap-3 rounded-row border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">Guardian {i + 1}</span>
                  <span className="flex items-center gap-1">
                    {emailOn && <Segmented size="sm" label={`How guardian ${i + 1} is named`} value={kinds[i]!} onChange={(k) => setKind(i, k)} options={KIND_OPTIONS} />}
                    {d.guardians.length > 1 && (
                      <button type="button" aria-label={`Remove guardian ${i + 1}`} onClick={() => remove(i)} className="flex size-11 shrink-0 items-center justify-center rounded-tile text-muted hover:bg-subtle hover:text-ink">
                        <Trash2 aria-hidden className="size-[18px]" />
                      </button>
                    )}
                  </span>
                </div>
                <Field
                  label={
                    <>
                      {mail ? "Email address" : "NEAR account"} <span className="sr-only">of guardian {i + 1}</span>
                    </>
                  }
                  error={errors[`guardian.${i}`]}
                  hint={mail ? emailHint(g, d.emails, "guardian") : emailOn ? "Their NEAR account, or the 0x address of their Ethereum wallet. They sign in with that wallet." : undefined}
                >
                  {(p) => (
                    <input
                      {...p}
                      type={mail ? "email" : "text"}
                      inputMode={mail ? "email" : undefined}
                      className={inputClass}
                      placeholder={mail ? (["dayo@example.com", "funmi@example.com", "chidi@example.com"][i] ?? "name@example.com") : (["dayo.testnet", "funmi.testnet", "chidi.testnet"][i] ?? "guardian.testnet")}
                      value={g}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                      onChange={(e) => setGuardian(i, e.target.value)}
                    />
                  )}
                </Field>
                {emailOn && !mail && typed && (
                  <Field label="Their email" optional error={errors[`guardian.${i}.email`]} hint="We'll tell them they're a guardian, and write when they're needed.">
                    {(p) => (
                      <input
                        {...p}
                        type="email"
                        className={inputClass}
                        placeholder="name@example.com"
                        value={d.noticeEmails[typed] ?? ""}
                        autoComplete="off"
                        spellCheck={false}
                        autoCapitalize="none"
                        onChange={(e) => set("noticeEmails", { ...d.noticeEmails, [typed]: e.target.value })}
                      />
                    )}
                  </Field>
                )}
              </li>
            );
          })}
        </ul>
        <Button type="button" variant="outline" size="sm" icon={Plus} className="self-start" onClick={add}>
          Add guardian
        </Button>
        {errors.guardians && <span className="text-[13px] font-semibold text-error">{errors.guardians}</span>}
      </Card>
      {emailOn && anyEmail && <OwnerNameCard d={d} set={set} owner={owner} />}
      <Card className="flex flex-col gap-4">
        <SectionTitle title={<Term k="quorum">Approvals needed</Term>} sub="How many guardians must agree before a release goes ahead." />
        <Segmented
          label="Approvals needed"
          value={String(q)}
          onChange={(v) => set("quorum", v)}
          options={Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: `${i + 1}` }))}
        />
        <p className="text-[15px]">
          Any <strong>{q}</strong> of <strong>{filled || "your"}</strong> guardian{filled === 1 ? "" : "s"} can release the plan. {q === 1 && filled > 1 ? "One person acting alone is convenient but less safe." : ""}
        </p>
        {errors.quorum && <span className="text-[13px] font-semibold text-error">{errors.quorum}</span>}
      </Card>
      {!editing && (
        <Card className="flex flex-col gap-3">
          <SectionTitle title="Availability checks" sub="A regular check that your guardians are still reachable. Each guardian confirms once within the period you choose, and any vote they cast counts as confirming. If one goes quiet, you and your heirs are told, so there is time to replace them before they are needed. You can add standby guardians later on your plan page." />
          <Segmented
            label="Availability checks"
            value={String(d.availability)}
            onChange={(v) => set("availability", Number(v))}
            options={availabilityChoices(demo, d.availability).map((ms) => ({ value: String(ms), label: ms ? duration(ms) : "Off" }))}
          />
          <p className="text-sm text-muted">{d.availability ? `Each guardian confirms at least once every ${duration(d.availability)}.` : "Nobody checks that your guardians are still reachable."}</p>
        </Card>
      )}
    </>
  );
}

/** People named by email don't know the owner as an account: what the emails should call them. */
function OwnerNameCard({ d, set, owner }: { d: Draft; set: SetFn; owner: string }) {
  const shown = d.ownerName.trim() || shortName(owner);
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={Mail} title="How should the emails introduce you?" sub="The people you name by email hear from Behest, so they need to recognise who named them." />
      <Field label="Your name" optional hint={`They'll read: "${shown} named you a guardian of their inheritance plan."`}>
        {(p) => <input {...p} className={inputClass} placeholder="Kemi Adeyemi" maxLength={40} value={d.ownerName} autoComplete="name" onChange={(e) => set("ownerName", e.target.value)} />}
      </Field>
    </Card>
  );
}

function HeirStep({ d, set, errors, intents, demo, fallback, sealedInfo, emailOn, extOk }: { d: Draft; set: SetFn; errors: FieldErrors; intents: boolean; demo: boolean; fallback: boolean; sealedInfo: { count: number; known: number } | null; emailOn: boolean; extOk: boolean }) {
  const total = sharesTotal(d.heirs);
  const upd = (i: number, x: Partial<HeirDraft>) => set("heirs", d.heirs.map((h, j) => (j === i ? { ...h, ...x } : h)));
  /**
   * Typing a different person into a row. Addresses entered for an account belong
   * to that account: when the row becomes an email (or stops being one), they are
   * dropped rather than silently kept as where the new person is paid.
   */
  const fallbackKind: PersonKind = emailOn ? "email" : "account";
  const kind = (h: HeirDraft) => kindOf(h.account, h.by, fallbackKind);
  /** Switching how a heir is named starts the row again: addresses entered for an account aren't where an email's share should go, and the reverse. */
  const setKind = (i: number, h: HeirDraft, by: PersonKind) => {
    if (kind(h) !== by) upd(i, { by, account: "", near: "", eth: "", btc: "", intents: false, intentsAccount: "", noticeEmail: "" });
  };
  const priv = d.privacy === "private";
  return (
    <>
      <PrivacyCard d={d} set={set} demo={demo} fallback={fallback} sealedInfo={sealedInfo} />
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cx("text-sm font-semibold", total === 10_000 ? "text-ok" : "text-warn")}>{total === 10_000 ? "100% allocated" : total < 10_000 ? `${percent(total)} allocated · ${percent(10_000 - total)} left` : `${percent(total)} allocated · ${percent(total - 10_000)} too much`}</span>
          <Button type="button" variant="subtle" size="sm" icon={Divide} onClick={() => set("heirs", d.heirs.map((h, i) => ({ ...h, pct: splitEvenly(d.heirs.length)[i]! })))}>
            Split evenly
          </Button>
        </div>
        <ShareBar heirs={d.heirs.map((h, i) => ({ account_id: `${i}`, share_bps: Math.round(Number(h.pct) * 100) || 0 }))} />
        {errors.shares && <span className="text-[13px] font-semibold text-error">{errors.shares}</span>}
      </Card>
      <ul className="flex flex-col gap-3">
        {d.heirs.map((h, i) => {
          const mail = kind(h) === "email";
          return (
          <li key={i} className="animate-fade-up">
            <Card className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{h.label?.trim() || (h.account.trim() ? (mail ? h.account.trim() : shortName(h.account.trim())) : `Heir ${i + 1}`)}</span>
                <span className="flex items-center gap-1">
                  {emailOn && <Segmented size="sm" label={`How heir ${i + 1} is named`} value={kind(h)} onChange={(by) => setKind(i, h, by)} options={KIND_OPTIONS} />}
                  {d.heirs.length > 1 && (
                    <button type="button" aria-label={`Remove heir ${i + 1}`} onClick={() => set("heirs", d.heirs.filter((_, j) => j !== i))} className="flex size-11 shrink-0 items-center justify-center rounded-tile text-muted hover:bg-subtle hover:text-ink">
                      <Trash2 aria-hidden className="size-[18px]" />
                    </button>
                  )}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                <Field
                  label={
                    <>
                      {mail ? "Email address" : "NEAR account"} <span className="sr-only">of heir {i + 1}</span>
                    </>
                  }
                  error={errors[`heir.${i}.account`]}
                  hint={mail ? `${emailHint(h.account, d.emails, "heir")}${extOk || priv ? "" : " On the Free plan that is NEAR; Ethereum and Bitcoin come with Standard."}` : "Their sign-in, and where NEAR goes unless you set another account below. An Ethereum wallet's account is its 0x address."}
                >
                  {(p) => <input {...p} type={mail ? "email" : "text"} inputMode={mail ? "email" : undefined} className={inputClass} placeholder={mail ? "amara@example.com" : "amara.testnet"} value={h.account} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { account: e.target.value })} />}
                </Field>
                <Field label="Share" error={errors[`heir.${i}.pct`]}>
                  {(p) => (
                    <div className="flex min-h-12 items-center rounded-row bg-subtle px-4 focus-within:ring-2 focus-within:ring-signal/40">
                      <input {...p} className="min-w-0 flex-1 bg-transparent text-2xl font-bold outline-none" inputMode="decimal" value={h.pct} onChange={(e) => upd(i, { pct: e.target.value })} />
                      <span className="text-lg font-medium text-muted">%</span>
                    </div>
                  )}
                </Field>
              </div>
              {(() => {
                // Everything past "who and how much" is optional. One named field for an email heir; the rest folds away.
                const name = (
                  <Field label="Their name" optional hint="Only you see this. It replaces the address on your screens.">
                    {(p) => <input {...p} className={inputClass} placeholder="What you call them" maxLength={60} value={h.label ?? ""} autoComplete="off" onChange={(e) => upd(i, { label: e.target.value })} />}
                  </Field>
                );
                const addresses = (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="NEAR goes to" optional error={errors[`heir.${i}.near`]} hint={mail ? "Defaults to the NEAR account kept for their email." : h.account.trim() ? `Defaults to ${h.account.trim()}.` : "Defaults to the heir account."}>
                      {(p) => <input {...p} className={inputClass} placeholder={mail ? "their-own.testnet" : h.account || "amara.testnet"} value={h.near} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { near: e.target.value })} />}
                    </Field>
                    <div className="flex flex-col gap-1.5">
                      <Field label="Ethereum address" optional error={errors[`heir.${i}.eth`]} hint={mail ? "Defaults to the Ethereum address kept for their email." : "For Sepolia ETH and tokens. Without one they receive no ETH."}>
                        {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} placeholder="0x…" value={h.eth} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { eth: e.target.value })} />}
                      </Field>
                      {!mail && <IntentsBridgeAddress account={(h.intentsAccount || h.near || h.account).trim().toLowerCase()} chain="eth:1" onUse={(eth) => upd(i, { eth })} />}
                    </div>
                  </div>
                );
                const bitcoin = priv && (
                  <Field label="Bitcoin address" optional error={errors[`heir.${i}.btc`]} hint={mail ? "Kept inside their private record. Defaults to the Bitcoin address kept for their email." : "Kept inside their private record. Testnet tb1q… or tb1p…."}>
                    {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} placeholder="tb1q…" value={h.btc ?? ""} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { btc: e.target.value })} />}
                  </Field>
                );
                // A field with an error must never sit inside a closed section.
                const wrong = ["near", "eth", "btc", "email", "intents"].some((k) => errors[`heir.${i}.${k}`]);
                if (mail)
                  return (
                    <>
                      {emailOn && <div className="sm:max-w-[calc(50%-8px)]">{name}</div>}
                      {/* Named by email, everything already has somewhere to land; other addresses are the exception. */}
                      <Disclosure key={`mail-${wrong}`} title="Pay to wallets they already have" sub="Only if you know their own addresses. Otherwise leave this closed." defaultOpen={wrong || !!(h.near.trim() || h.eth.trim() || h.btc?.trim())}>
                        <div className="flex flex-col gap-4">
                          {addresses}
                          {bitcoin}
                        </div>
                      </Disclosure>
                    </>
                  );
                const filled = [h.eth.trim() && "Ethereum address", h.near.trim() && "another NEAR account", h.label?.trim() && "name", h.noticeEmail?.trim() && "email", h.intents && "NEAR Intents"].filter(Boolean);
                return (
                  <>
                    {bitcoin}
                    <Disclosure
                      key={`account-${wrong}`}
                      title="More for this heir"
                      sub={filled.length ? `Set: ${filled.join(", ")}.` : "An Ethereum address, another NEAR account, their name and an email for notices. All optional."}
                      defaultOpen={wrong || filled.length > 0}
                    >
                      <div className="flex flex-col gap-4">
                        {addresses}
                        {emailOn && (
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {name}
                            <Field label="Their email" optional error={errors[`heir.${i}.email`]} hint="Where to write to them about this plan.">
                              {(p) => <input {...p} type="email" className={inputClass} placeholder="name@example.com" value={h.noticeEmail ?? ""} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { noticeEmail: e.target.value })} />}
                            </Field>
                          </div>
                        )}
                        {intents && (
                          <div className="flex flex-col gap-3 rounded-row border border-line p-4">
                            <label className="flex cursor-pointer items-start gap-3 text-[15px]">
                              <input type="checkbox" checked={!!h.intents} onChange={(e) => upd(i, { intents: e.target.checked })} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
                              <span>
                                <strong>Receive through NEAR Intents</strong>
                                <span className="block text-sm text-muted">Their NEAR and NEAR tokens are paid into their NEAR Intents account instead of their wallet. From there they can keep them, withdraw them or swap them to almost any asset on almost any chain. Standard plan or above.</span>
                              </span>
                            </label>
                            {h.intents && (
                              <Field label="Intents account" optional error={errors[`heir.${i}.intents`]} hint={`Defaults to ${(h.near || h.account).trim() || "their NEAR account"}. An Ethereum wallet's Intents account is its 0x address.`}>
                                {(p) => <input {...p} className={`${inputClass} font-mono text-sm`} placeholder={(h.near || h.account).trim() || "amara.testnet"} value={h.intentsAccount ?? ""} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => upd(i, { intentsAccount: e.target.value })} />}
                              </Field>
                            )}
                          </div>
                        )}
                      </div>
                    </Disclosure>
                  </>
                );
              })()}
            </Card>
          </li>
          );
        })}
      </ul>
      <Button type="button" variant="outline" icon={Plus} className="self-start" onClick={() => set("heirs", [...d.heirs, { account: "", pct: "0", near: "", eth: "", by: fallbackKind }])}>
        Add heir
      </Button>
      {emailOn && d.heirs.some((h) => looksLikeEmail(h.account) || h.noticeEmail?.trim()) && (
        <Card className="flex flex-col gap-3">
          <SectionTitle icon={Mail} title="When should your heirs hear from us?" sub="Guardians are told as soon as the plan names them, because they have a job to do. Heirs are your call." />
          <Segmented
            label="When heirs are emailed"
            value={d.tellHeirs ? "now" : "later"}
            onChange={(v) => set("tellHeirs", v === "now")}
            options={[
              { value: "later", label: "When a release reaches them" },
              { value: "now", label: "Now" },
            ]}
          />
          <p className="text-sm text-muted">{d.tellHeirs ? "Each heir gets one email saying you named them, with nothing to do yet." : "They hear nothing until a release is approved and their share is on its way."} Every email has an unsubscribe link.</p>
        </Card>
      )}
      {!priv && <p className="text-sm text-muted">Bitcoin addresses are added on your plan page once the Bitcoin vault is set up{emailOn ? "; a heir named by email already has one waiting" : ""}.</p>}
    </>
  );
}

function FundingStep({ d, set, errors, evm, sponsored }: { d: Draft; set: SetFn; errors: FieldErrors; evm: boolean; sponsored: boolean }) {
  if (evm)
    return (
      <Card className="flex flex-col gap-4">
        <SectionTitle icon={Coins} title="Nothing to send now" sub="An email or Ethereum-wallet sign-in can't attach NEAR, so this plan starts without a NEAR balance." />
        <ul className="flex flex-col gap-2 text-[15px] leading-relaxed">
          <li className="flex gap-2">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
            <span>Send Sepolia ETH, allowed tokens or testnet Bitcoin to the plan&apos;s vault addresses, shown on your plan page after saving.</span>
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
            <span>Anyone with a NEAR wallet can add NEAR to your plan for you.</span>
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
            <span>{sponsored ? "Behest covers the plan's storage and gas, so saving costs you nothing." : "Behest pays the gas for everything you sign."}</span>
          </li>
        </ul>
      </Card>
    );
  return (
    <Card className="flex flex-col gap-4">
      <Field label="NEAR to set aside" error={errors.deposit} hint="You can add or withdraw later, while no release is open. Zero is fine.">
        {(p) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center rounded-row bg-subtle px-4 focus-within:ring-2 focus-within:ring-signal/40">
              <input {...p} className="min-h-16 min-w-0 flex-1 bg-transparent text-[28px] font-bold outline-none" inputMode="decimal" value={d.deposit} onChange={(e) => set("deposit", e.target.value)} />
              <span className="text-xl font-medium text-muted">NEAR</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["0", "0.1", "0.5", "1"].map((x) => (
                <button key={x} type="button" onClick={() => set("deposit", x)} className={cx("min-h-9 rounded-full border px-3 text-sm", d.deposit === x ? "border-signal bg-s-approved" : "border-line hover:bg-subtle")}>
                  {x} NEAR
                </button>
              ))}
            </div>
          </div>
        )}
      </Field>
      <Notice tone={sponsored ? "ok" : "info"}>
        {sponsored ? "Behest covers the plan's storage, so saving needs no deposit." : "Saving also attaches 0.1 NEAR for the plan's storage; the contract refunds what it doesn't use."} {Number(d.deposit) > 0 ? "Adding NEAR is a second transaction." : ""}
      </Notice>
    </Card>
  );
}

/** "If you stop checking in": the release clock, with the plan's own durations. */
function Consequences({ plan, unset }: { plan: PlanInput; unset?: { checkIn: boolean; grace: boolean; waiting: boolean } }) {
  const items: [string, string][] = [
    ["You stop checking in", unset?.checkIn ? "not set" : `after ${duration(plan.check_in_interval_ms)}`],
    ["Grace period", unset?.grace ? "not set" : plan.grace_ms > 0 ? duration(plan.grace_ms) : "none"],
    ["Guardians approve", plan.guardians.length ? `${plan.quorum || "?"} of ${plan.guardians.length}` : "—"],
    ["Waiting, you can cancel", unset?.waiting ? "not set" : duration(plan.waiting_period_ms)],
    ["Heirs receive", plan.heirs.length ? `${plan.heirs.length} heir${plan.heirs.length === 1 ? "" : "s"}` : "—"],
  ];
  return (
    <ol className="flex flex-col">
      {items.map(([k, v], i) => (
        <li key={k} className="relative flex items-start gap-3 pb-3 last:pb-0">
          {i < items.length - 1 && <span aria-hidden className="absolute bottom-0 left-[5px] top-4 w-0.5 bg-line" />}
          <span aria-hidden className={cx("relative mt-1.5 size-3 shrink-0 rounded-full", i === items.length - 1 ? "bg-signal" : "bg-card ring-2 ring-line-strong")} />
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-sm">
            <span>{k}</span>
            <span className="tabular shrink-0 text-muted">{v}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ReviewStep({
  summaryInput,
  plan,
  d,
  owner,
  editing,
  depositYocto,
  onEdit,
  finalErrors,
  ack,
  setAck,
  evm,
  sponsored,
  spons,
}: {
  summaryInput: Parameters<typeof planSummary>[0];
  evm: boolean;
  sponsored: boolean;
  spons: Sponsorship | null | undefined;
  plan: PlanInput;
  d: Draft;
  owner: string;
  editing: boolean;
  depositYocto: bigint | null;
  onEdit: (s: WizardStep) => void;
  finalErrors: string[];
  ack: boolean;
  setAck: (b: boolean) => void;
}) {
  const edit = (s: WizardStep) => (
    <Button type="button" variant="ghost" size="sm" icon={Pencil} onClick={() => onEdit(s)}>
      Edit
    </Button>
  );
  return (
    <>
      <Card className="flex flex-col gap-4">
        <span className="text-sm font-semibold text-muted">What you&apos;re signing</span>
        <p className="text-[clamp(20px,2.4vw,26px)] leading-snug tracking-[-0.015em]">{describePlan(plan)}</p>
      </Card>
      <Card className="flex flex-col gap-4">
        <SectionTitle title="In plain words" sub="Every part of the plan, what it means, and what to watch out for." />
        <SummaryList input={summaryInput} />
      </Card>
      <Card className="flex flex-col gap-4">
        <SectionTitle icon={Timer} title="If you stop checking in" aside={edit("timing")} />
        <Consequences plan={plan} />
      </Card>
      <Card className="flex flex-col gap-3">
        <SectionTitle icon={ShieldCheck} title={`Guardians · any ${plan.quorum} of ${plan.guardians.length}`} aside={edit("guardians")} />
        <ul className="flex flex-wrap gap-2">
          {plan.guardians.map((g) => (
            <li key={g} className="inline-flex min-h-9 items-center rounded-full bg-subtle px-3 font-mono text-[13px]">
              {g}
            </li>
          ))}
        </ul>
      </Card>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-semibold text-muted">Heirs{d.privacy === "private" ? " · private: only you see this list" : ""}</span>
          {edit("heirs")}
        </div>
        {intentsDeliveries(d.heirs).length > 0 && (
          <p className="px-1 text-sm text-muted">
            Through NEAR Intents: {intentsDeliveries(d.heirs).map((x) => shortName(x.account_id)).join(", ")}.
          </p>
        )}
        <HeirList view={{ status: "Active", overdue_at_ms: 0, now_ms: 0, plan: { owner, version: 0, policy: plan, last_check_in_ms: 0, escrow: "0", eth_next_nonce: 0, proposal: null, proposals_opened: 0 } }} />
      </div>
      {!editing && depositYocto != null && depositYocto > 0n && (
        <Card className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-3">
            <Coins aria-hidden className="size-5 text-muted" />
            You&apos;ll put <strong>{d.deposit} NEAR</strong> into the plan (a second transaction).
          </span>
          {edit("funding")}
        </Card>
      )}
      <StorageNote evm={evm} sponsored={sponsored} spons={spons} />
      <Disclosure icon={ScrollText} title="Exact contract call" sub={evm ? "set_plan, inside the message your wallet signs" : "set_plan, as it will be signed"}>
        <pre className="overflow-auto rounded-tile bg-void p-4 font-mono text-xs leading-relaxed text-white">{JSON.stringify(d.privacy === "private" ? { method: "set_private_plan", args: { plan: { ...plan, heirs: [] }, sealed: { commitments: plan.heirs.map(() => "<fingerprint of the heir's record>"), reveal_window_ms: d.revealWindow, unrevealed: d.unrevealed } } } : { method: "set_plan", args: { plan } }, null, 2)}</pre>
      </Disclosure>
      {finalErrors.length > 0 && (
        <Notice tone="error" title="Fix these first">
          <ul className="list-disc pl-5">
            {finalErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-row border border-line bg-card p-4 text-[15px]">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
        <span>I understand that once a release is approved and its waiting period ends, it can&apos;t be cancelled, and that funds go only to the addresses above.</span>
      </label>
    </>
  );
}

/** Who pays for the plan's storage (D24), and what an Ethereum wallet can't do. */
function StorageNote({ evm, sponsored, spons }: { evm: boolean; sponsored: boolean; spons: Sponsorship | null | undefined }) {
  if (spons === undefined) return <Skeleton className="h-14 w-full rounded-row" />;
  if (sponsored)
    return (
      <Notice tone="ok" title="Behest covers the plan's storage">
        {evm ? "Your wallet signs a message; Behest sends it and pays the gas and storage. No ETH or NEAR leaves your wallet." : "No deposit needed. If Behest can't cover it this time, your wallet asks you to attach 0.1 NEAR instead (unused storage is refunded)."}
      </Notice>
    );
  if (evm)
    return (
      <Notice tone="warn" title="Behest can't cover storage right now">
        {spons === null ? "This deployment doesn't sponsor plan storage yet" : "Its sponsor pool or your allowance is used up"}, and an email or Ethereum-wallet sign-in can&apos;t attach NEAR. Try again later, or sign in with a NEAR wallet.
      </Notice>
    );
  return <Notice>Saving attaches 0.1 NEAR for the plan&apos;s storage; the contract refunds what it doesn&apos;t use.</Notice>;
}

function SigningProgress({ phase, withDeposit, evm }: { phase: "idle" | "plan" | "deposit" | "done"; withDeposit: boolean; evm: boolean }) {
  const rows: [string, boolean, boolean][] = [
    ["Saving your plan", phase === "plan", phase === "deposit" || phase === "done"],
    ...(withDeposit ? [["Adding NEAR to the plan", phase === "deposit", phase === "done"] as [string, boolean, boolean]] : []),
  ];
  return (
    <ol role="status" className="flex flex-col gap-2 rounded-row border border-line bg-card p-4">
      {rows.map(([label, on, done]) => (
        <li key={label} className="flex items-center gap-3 text-[15px]">
          <span className={cx("flex size-6 items-center justify-center rounded-full", done ? "bg-ok-bg text-ok" : on ? "bg-s-approved text-[var(--s-approved-fg)]" : "bg-subtle text-muted")}>
            {done ? <Check aria-hidden className="size-3.5" /> : on ? <BehestLoader size={20} label="In progress" /> : null}
          </span>
          <span className={cx(!on && !done && "text-muted")}>{label}</span>
          {on && <span className="text-sm text-muted">· {evm ? "sign the message in your wallet" : "confirm in your wallet"}</span>}
        </li>
      ))}
    </ol>
  );
}
