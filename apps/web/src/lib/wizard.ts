// Setup wizard: per-step, per-field validation of a draft plan, so errors show
// next to the field that caused them. The contract's own rules (and
// validateDraft in plan.ts) remain the final gate on the review step.
import { percent } from "./plan";

export const WIZARD_STEPS = ["start", "timing", "guardians", "heirs", "funding", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Unit = "minutes" | "hours" | "days" | "months";
/** A month is a fixed 30 days: the contract counts milliseconds, not calendar months. */
export const UNIT_MS: Record<Unit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, months: 30 * 86_400_000 };

/** The longest each timer may be; the contract enforces the same ceilings. */
export const TIMER_MAX_MS = { checkIn: 365 * UNIT_MS.days, grace: 30 * UNIT_MS.days, waiting: 180 * UNIT_MS.days };

export interface TimerDraft {
  n: string;
  unit: Unit;
}
export interface HeirDraft {
  account: string;
  pct: string;
  near: string;
  eth: string;
  /** D27: paid into their NEAR Intents account instead of their wallet. */
  intents?: boolean;
  /** D27: that Intents account, when not their NEAR destination (e.g. a 0x address). */
  intentsAccount?: string;
  /** D33 (private plans): a Bitcoin address inside the sealed record. */
  btc?: string;
  /** D33: the record's salt, kept while editing so unchanged heirs keep their commitment. */
  salt?: string;
  /** What the owner calls them (private: kept with their email, never on-chain). */
  label?: string;
  /** For a heir named by account: where to write to them about this plan. */
  noticeEmail?: string;
}

/** What an email address typed for a guardian or heir turned into (the wallets kept for that address). */
export interface EmailAccount {
  account: string;
  near: string;
  btc: string;
}
/** Email (lowercased) → its account, once resolved. */
export type EmailAccounts = Record<string, EmailAccount>;

const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export const looksLikeEmail = (s: string) => s.trim().length <= 254 && EMAIL.test(s.trim());

/** The account a guardian or heir entry stands for: itself, or the one made for its email ("" until resolved). */
export function accountOf(entry: string, emails: EmailAccounts = {}): string {
  const e = entry.trim().toLowerCase();
  return looksLikeEmail(e) ? (emails[e]?.account ?? "") : e;
}
/** Guardian and heir entries that are emails still waiting for an account. */
export function unresolvedEmails(entries: string[], emails: EmailAccounts = {}): string[] {
  return [...new Set(entries.map((x) => x.trim().toLowerCase()).filter((x) => looksLikeEmail(x) && !emails[x]))];
}
/** Field key → message. Keys: checkIn, grace, waiting, guardian.<i>, guardians, quorum, heir.<i>.<field>, shares, deposit. */
export type FieldErrors = Record<string, string>;

export const toMs = (t: TimerDraft) => Math.round(Number(t.n) * UNIT_MS[t.unit]);

export function fromMs(ms: number): TimerDraft {
  if (ms > 0 && ms % UNIT_MS.months === 0) return { n: String(ms / UNIT_MS.months), unit: "months" };
  if (ms > 0 && ms % UNIT_MS.days === 0) return { n: String(ms / UNIT_MS.days), unit: "days" };
  if (ms > 0 && ms % UNIT_MS.hours === 0) return { n: String(ms / UNIT_MS.hours), unit: "hours" };
  return { n: String(ms / UNIT_MS.minutes), unit: "minutes" };
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** Named, implicit (64 hex) or eth-implicit (0x…) NEAR account, format only. */
export function looksLikeNearAccount(a: string): boolean {
  const s = a.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s) || /^0x[0-9a-f]{40}$/.test(s)) return true;
  return s.length >= 2 && s.length <= 64 && NEAR_ACCOUNT.test(s);
}

export const looksLikeEthAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

export function timingErrors(t: { checkIn: TimerDraft; grace: TimerDraft; waiting: TimerDraft }, demo: boolean): FieldErrors {
  const e: FieldErrors = {};
  const num = (x: TimerDraft) => x.n.trim() !== "" && Number.isFinite(Number(x.n)) && Number(x.n) >= 0;
  for (const k of ["checkIn", "grace", "waiting"] as const) if (!num(t[k])) e[k] = "Enter a number.";
  const ci = toMs(t.checkIn);
  const gr = toMs(t.grace);
  const wa = toMs(t.waiting);
  if (!e.checkIn) {
    if (demo && ci < UNIT_MS.minutes) e.checkIn = "At least 1 minute.";
    if (!demo && ci < 30 * UNIT_MS.days) e.checkIn = "At least 1 month (30 days).";
    if (ci > TIMER_MAX_MS.checkIn) e.checkIn = "At most 12 months (365 days).";
  }
  if (!e.grace) {
    if (!demo && gr < UNIT_MS.days) e.grace = "Between 1 and 30 days.";
    if (gr > TIMER_MAX_MS.grace) e.grace = demo ? "At most 1 month (30 days)." : "Between 1 and 30 days.";
  }
  if (!e.waiting) {
    if (demo && wa < UNIT_MS.minutes) e.waiting = "At least 1 minute.";
    if (!demo && wa < 7 * UNIT_MS.days) e.waiting = "At least 7 days.";
    if (wa > TIMER_MAX_MS.waiting) e.waiting = "At most 6 months (180 days).";
  }
  return e;
}

export function guardianErrors(guardians: string[], quorum: string, owner: string, emails: EmailAccounts = {}, noticeEmails: Record<string, string> = {}): FieldErrors {
  const e: FieldErrors = {};
  const list = guardians.map((g) => g.trim().toLowerCase());
  // An email stands for its account once resolved; until then it is compared as typed.
  const ids = list.map((g) => accountOf(g, emails) || g);
  const filled = list.filter(Boolean);
  list.forEach((g, i) => {
    if (!g) return;
    const mail = looksLikeEmail(g);
    if (!mail && !looksLikeNearAccount(g)) e[`guardian.${i}`] = g.includes("@") ? "That doesn't look like an email address." : "Enter their email address, or a NEAR account (e.g. dayo.testnet).";
    else if (ids[i] === owner) e[`guardian.${i}`] = "You can't guard your own plan.";
    else if (ids.indexOf(ids[i]!) !== i) e[`guardian.${i}`] = "Already listed.";
    const notice = noticeEmails[g]?.trim();
    if (!mail && notice && !looksLikeEmail(notice)) e[`guardian.${i}.email`] = "That doesn't look like an email address.";
  });
  if (filled.length === 0) e.guardians = "Add at least one guardian.";
  const q = Number(quorum);
  if (!Number.isInteger(q) || q < 1 || q > Math.max(1, filled.length)) e.quorum = `Choose between 1 and ${Math.max(1, filled.length)}.`;
  return e;
}

export function sharesTotal(heirs: HeirDraft[]): number {
  return heirs.reduce((s, h) => s + (Math.round(Number(h.pct) * 100) || 0), 0);
}

export function heirErrors(heirs: HeirDraft[], owner: string, guardians: string[], emails: EmailAccounts = {}): FieldErrors {
  const e: FieldErrors = {};
  const key = (x: string) => accountOf(x, emails) || x.trim().toLowerCase();
  const gs = guardians.filter((g) => g.trim()).map(key);
  const ids = heirs.map((h) => key(h.account));
  heirs.forEach((h, i) => {
    const id = ids[i]!;
    const typed = h.account.trim().toLowerCase();
    if (!id) e[`heir.${i}.account`] = "Enter their email address, or a NEAR account.";
    else if (!looksLikeEmail(typed) && !looksLikeNearAccount(typed)) e[`heir.${i}.account`] = typed.includes("@") ? "That doesn't look like an email address." : "Enter their email address, or a NEAR account.";
    else if (id === owner) e[`heir.${i}.account`] = "You can't be your own heir.";
    else if (gs.includes(id)) e[`heir.${i}.account`] = "Someone can't be both an heir and a guardian.";
    else if (ids.indexOf(id) !== i) e[`heir.${i}.account`] = "Already listed.";
    const pct = Number(h.pct);
    if (h.pct.trim() === "" || !Number.isFinite(pct) || pct <= 0 || pct > 100) e[`heir.${i}.pct`] = "Between 0 and 100.";
    else if (Math.abs(pct * 100 - Math.round(pct * 100)) > 1e-6) e[`heir.${i}.pct`] = "At most two decimals.";
    if (h.near.trim() && !looksLikeNearAccount(h.near)) e[`heir.${i}.near`] = "That doesn't look like a NEAR account.";
    if (h.eth.trim() && !looksLikeEthAddress(h.eth)) e[`heir.${i}.eth`] = "An Ethereum address is 0x followed by 40 characters.";
    if (h.intents && h.intentsAccount?.trim() && !looksLikeNearAccount(h.intentsAccount)) e[`heir.${i}.intents`] = "A NEAR account or a 0x address.";
    if (h.btc?.trim() && !/^tb1[02-9ac-hj-np-z]{8,87}$/.test(h.btc.trim())) e[`heir.${i}.btc`] = "A testnet Bitcoin address starts with tb1.";
    if (h.noticeEmail?.trim() && !looksLikeEmail(h.noticeEmail)) e[`heir.${i}.email`] = "That doesn't look like an email address.";
  });
  if (heirs.length === 0) e.shares = "Add at least one heir.";
  else {
    const total = sharesTotal(heirs);
    if (total !== 10_000) e.shares = `Shares add up to ${percent(total)}; they must add up to 100%.`;
  }
  return e;
}

/** Even split in percent with two decimals that sums to exactly 100 (the first heirs take the rounding). */
export function splitEvenly(n: number): string[] {
  if (n <= 0) return [];
  const base = Math.floor(10_000 / n);
  const extra = 10_000 - base * n;
  return Array.from({ length: n }, (_, i) => String((base + (i < extra ? 1 : 0)) / 100));
}

/** Which step a field error belongs to. */
export function stepOf(key: string): WizardStep {
  if (key === "checkIn" || key === "grace" || key === "waiting") return "timing";
  if (key.startsWith("guardian") || key === "quorum") return "guardians";
  if (key.startsWith("heir") || key === "shares") return "heirs";
  if (key === "deposit") return "funding";
  if (key === "preset") return "start";
  return "review";
}

/** D27: the set_intents_delivery list for a draft (opted-in heirs only). */
export function intentsDeliveries(heirs: HeirDraft[]) {
  return heirs
    .filter((h) => h.intents && h.account.trim() && !looksLikeEmail(h.account))
    .map((h) => ({ account_id: h.account.trim().toLowerCase(), enabled: true, intents_account: h.intentsAccount?.trim() ? h.intentsAccount.trim().toLowerCase() : null }));
}
