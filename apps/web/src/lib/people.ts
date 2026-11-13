// People an owner names with an email address instead of an account. The
// notifier asks Privy for the wallets kept for that address and hands back the
// account to write into the plan; the person later signs in with the same
// address and finds themselves holding it. Emails never go on-chain: they live
// in the notifier's private database and, for showing names, in this browser.
import { hasSession, openSession, request, NotifierError } from "./notify";
import { registerNames } from "./plan";
import type { Session } from "./session";

export type PersonRole = "heir" | "guardian" | "standby" | "delay" | "recipient";

export interface Person {
  account: string;
  role: PersonRole;
  email: string;
  label: string | null;
  /** The account is the wallet created for the address (they sign in with it). */
  by_email: boolean;
  announce: boolean;
  near: string | null;
  btc: string | null;
  told_ms: number | null;
  email_status: "active" | "unsubscribed" | "removed" | "pending" | "disabled";
}

export { looksLikeEmail } from "./wizard";
export const normEmail = (s: string) => s.trim().toLowerCase();

// ---- this browser's copy, so names show without asking the notifier (or a signature) again
const KEY = (owner: string) => `behest.people.${owner}`;

export function localPeople(owner: string): Person[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(owner)) ?? "[]") as Person[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function remember(owner: string, people: Person[]) {
  try {
    localStorage.setItem(KEY(owner), JSON.stringify(people));
  } catch {}
  register(people);
}

/** Shows these people by name or address wherever an account would be shortened. */
function register(people: Person[]) {
  registerNames(Object.fromEntries(people.filter((p) => p.by_email || p.label).map((p) => [p.account, p.label || p.email])));
}

/** Loads this browser's copy into the name registry (no network, no signature). */
export function usePeopleNames(owner: string | null | undefined): Person[] {
  if (!owner || typeof window === "undefined") return [];
  const people = localPeople(owner);
  register(people);
  return people;
}

const mergeIn = (owner: string, p: Person) => remember(owner, [...localPeople(owner).filter((x) => !(x.account === p.account && x.role === p.role)), p]);

const token = (session: Session) => openSession(session, `name people by email for ${session.accountId}`);

/**
 * Names someone by email. Without `account`, the notifier creates (or finds) the
 * wallets for the address and returns the account to put in the plan. With
 * `account`, the address is only where that account's notices about this plan go.
 */
export async function namePerson(session: Session, input: { email: string; role: PersonRole; account?: string; announce?: boolean; label?: string; name?: string }): Promise<Person> {
  const r = await request<{ person: Person }>("POST", "/v1/people", { ...input, email: normEmail(input.email) }, await token(session));
  mergeIn(session.accountId, r.person);
  return r.person;
}

/** Everyone this owner named by email. Asks for one signature unless a notifier session is already open. */
export async function listPeople(session: Session): Promise<{ name: string | null; people: Person[] }> {
  const r = await request<{ name: string | null; people: Person[] }>("GET", "/v1/people", undefined, await token(session));
  remember(session.accountId, r.people);
  return r;
}

/** Refreshes from the notifier only if that needs no signature. */
export async function refreshPeople(session: Session): Promise<Person[]> {
  if (!hasSession(session.accountId)) return localPeople(session.accountId);
  return (await listPeople(session).catch(() => ({ people: localPeople(session.accountId) }))).people;
}

export async function removePerson(session: Session, account: string, role: PersonRole): Promise<void> {
  await request("DELETE", `/v1/people/${encodeURIComponent(account)}?role=${role}`, undefined, await token(session)).catch((e) => {
    if (!(e instanceof NotifierError) || e.code !== "NOT_FOUND") throw e;
  });
  remember(session.accountId, localPeople(session.accountId).filter((x) => !(x.account === account && x.role === role)));
}

export async function setOwnerName(session: Session, name: string): Promise<string | null> {
  return (await request<{ name: string | null }>("PUT", "/v1/people/name", { name: name.trim() }, await token(session))).name;
}

/** Plain words for the notifier's refusals. */
export function peopleError(e: unknown): string {
  if (e instanceof NotifierError) {
    if (e.code === "EMAIL_WALLETS_UNAVAILABLE") return "Naming people by email isn't switched on here yet. Use their NEAR account instead.";
    if (e.code === "EMAIL_WALLETS_FAILED") return "Couldn't set up an account for that address just now. Try again in a moment.";
    if (e.code === "BAD_EMAIL") return "That doesn't look like an email address.";
    if (e.code === "BAD_NAME") return "Use a plain name of up to 40 letters.";
    if (e.code === "PEOPLE_LIMIT" || e.code === "LIMIT") return "That's more people with an email than one plan can have.";
    if (e.code === "UNREACHABLE") return "Behest's notification service isn't reachable, so the email couldn't be turned into an account. Try again in a moment.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * For someone signed in with an email: the plans that name their account, so
 * they don't need the owner's link, and what each owner asked to be called.
 * Opening the notifier session is a signature the email sign-in gives silently.
 */
export async function namedPlans(session: Session): Promise<{ owner: string; role: PersonRole; name: string | null }[]> {
  const r = await request<{ plans: { owner: string; role: PersonRole; name: string | null }[] }>("GET", "/v1/named", undefined, await openSession(session, `see the plans that name ${session.email?.email ?? session.accountId}`));
  registerNames(Object.fromEntries(r.plans.filter((p) => p.name).map((p) => [p.owner, p.name!])));
  return r.plans;
}
