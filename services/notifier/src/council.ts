// D26: a DAO (SputnikDAO v2, which Trezu manages) can own, guard or inherit a
// plan, but it can't sign in to the notifier or read email. A council member
// switches on "notify the whole council" for the DAO; from then on every
// notice addressed to the DAO also goes to each current council member's own
// contacts. Membership is read from the DAO's get_policy, so people who leave
// the council stop getting notices and new members start without a step.

export interface SputnikRole {
  name: string;
  kind: "Everyone" | { Group: string[] } | { Member: string };
  permissions?: string[];
}
export interface SputnikPolicy {
  roles: SputnikRole[];
}

/** Everyone in a Group role of the policy: the council, plus any other named groups. */
export function councilMembers(policy: SputnikPolicy | null | undefined): string[] {
  const out = new Set<string>();
  for (const r of policy?.roles ?? []) {
    if (typeof r.kind === "object" && "Group" in r.kind) r.kind.Group.forEach((m) => out.add(m));
  }
  return [...out].sort();
}

const NOT_A_DAO = /MethodNotFound|CodeDoesNotExist|MethodResolveError|does not exist|no contract/i;

export type CouncilOf = (dao: string) => Promise<string[] | null>;

/**
 * Reads a DAO's council through `viewAt`, caching it for `ttlMs`. Returns
 * null when the account isn't a DAO (no get_policy).
 */
export function councilReader(viewAt: <T>(contractId: string, method: string, args: Record<string, unknown>) => Promise<T>, ttlMs = 10 * 60_000, now = Date.now): CouncilOf {
  const cache = new Map<string, { at: number; members: string[] | null }>();
  return async (dao) => {
    const hit = cache.get(dao);
    if (hit && now() - hit.at < ttlMs) return hit.members;
    let members: string[] | null;
    try {
      members = councilMembers(await viewAt<SputnikPolicy>(dao, "get_policy", {}));
    } catch (e) {
      // An account without the method isn't a DAO; anything else is transient,
      // and the last known council stands (or the error goes to the caller).
      if (!NOT_A_DAO.test(String(e))) {
        if (hit) return hit.members;
        throw e;
      }
      members = null;
    }
    cache.set(dao, { at: now(), members });
    return members;
  };
}

/** Adds each opted-in DAO's council to a notice's recipients (without the DAO's own entry, which has no contacts). */
export async function withCouncils(recipients: string[], optedIn: (dao: string) => boolean, councilOf: CouncilOf): Promise<string[]> {
  const out = new Set(recipients);
  for (const r of recipients) {
    if (!optedIn(r)) continue;
    const members = await councilOf(r).catch(() => null);
    members?.forEach((m) => out.add(m));
  }
  return [...out];
}
