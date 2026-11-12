// Reads plans from the contract (views only; the notifier holds no keys) and
// turns changes into notices. Which plans: every open release, the operator's
// NOTIFY_OWNERS, every subscribed account's own plan (check-in reminders),
// plans subscribers asked to watch, and plans seen before until their
// release is resolved.
import type { Store } from "./db.js";
import { members, notices, recipients, type Ctx, type ExtensionState, type GuardianStatus, type DestinationRow, type Options, type PendingChange, type PlanView, type Proposal, type Snapshot, type Transfer } from "./diff.js";
import { withCouncils, type CouncilOf } from "./council.js";
import type { Engine } from "./engine.js";

export type View = <T>(method: string, args: Record<string, unknown>) => Promise<T>;
type Log = (msg: string, data?: Record<string, unknown>) => void;

interface ConfigView {
  erc20_tokens?: { address: string; symbol: string; decimals: number }[];
  nep141_tokens?: { account_id: string; symbol: string; decimals: number }[];
}

export class Watcher {
  private ctx: Ctx;
  private tokensAt = 0;

  constructor(
    private store: Store,
    private engine: Engine,
    private view: View,
    private opts: { owners: string[]; appUrl?: string; contractId: string; councilOf?: CouncilOf },
    private log: Log = () => {},
  ) {
    this.ctx = { appUrl: opts.appUrl, contractId: opts.contractId, tokens: {} };
  }

  private async refreshTokens() {
    if (Date.now() - this.tokensAt < 3_600_000) return;
    const c = await this.view<ConfigView>("get_config", {}).catch(() => null);
    if (!c) return;
    const t: NonNullable<Ctx["tokens"]> = {};
    for (const e of c.erc20_tokens ?? []) t[e.address.toLowerCase()] = { symbol: e.symbol, decimals: e.decimals };
    for (const n of c.nep141_tokens ?? []) t[n.account_id] = { symbol: n.symbol, decimals: n.decimals };
    this.ctx.tokens = t;
    this.tokensAt = Date.now();
  }

  async openReleases(): Promise<string[]> {
    const out: string[] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.view<string[]>("list_open_releases", { from_index: from, limit: 100 });
      out.push(...page);
      if (page.length < 100) return out;
    }
  }

  /** Owners to read this round, and the ones worth keeping a snapshot of. */
  async owners(): Promise<{ all: string[]; keep: Set<string> }> {
    const open = await this.openReleases();
    // A DAO with council notices on has no contacts of its own; its plan is watched for the council.
    const keep = new Set<string>([...open, ...this.opts.owners, ...this.store.subscribedAccounts(), ...this.store.watchedOwners().map((w) => w.owner), ...this.store.councils()]);
    return { all: [...new Set([...keep, ...this.store.knownOwners()])], keep };
  }

  async snapshot(owner: string, prev: Snapshot | null): Promise<Snapshot | null> {
    const view = await this.view<PlanView | null>("get_plan", { owner });
    if (!view) return null;
    const s: Snapshot = { view };
    const p = view.plan.proposal;
    const prevP = prev?.view.plan.proposal;
    const [options, extension, history, withdrawal, pending, guardians, destinations, destinationRequests] = await Promise.all([
      p ? this.view<Options | null>("get_release_options", { owner }) : Promise.resolve(undefined),
      p?.waiting_ends_at_ms ? this.view<ExtensionState | null>("get_extension", { owner }) : Promise.resolve(undefined),
      // needed to tell settled from cancelled, and to spot follow-up rounds
      p || prevP ? this.view<Proposal[]>("get_release_history", { owner }) : Promise.resolve(undefined),
      this.view<Transfer | null>("get_vault_withdrawal", { owner }),
      // D28/D29; undefined on a contract without them
      this.view<PendingChange[]>("get_pending_changes", { owner }).catch(() => undefined),
      this.view<GuardianStatus>("get_guardian_status", { owner }).catch(() => undefined),
      // D30/D31
      this.view<DestinationRow[]>("get_destinations", { owner }).catch(() => undefined),
      this.view<DestinationRow[]>("get_destination_requests", { owner }).catch(() => undefined),
    ]);
    if (options !== undefined) s.options = options;
    if (extension !== undefined) s.extension = extension;
    if (history !== undefined) s.history = history.map((h) => ({ id: h.id, created_at_ms: h.created_at_ms ?? 0 }));
    s.withdrawal = withdrawal;
    if (pending !== undefined) s.pending = pending;
    if (guardians !== undefined) s.guardians = guardians;
    if (destinations !== undefined) s.destinations = destinations;
    if (destinationRequests !== undefined) s.destinationRequests = destinationRequests;
    return s;
  }

  /** Reads one plan, fans out its new notices and stores the snapshot. */
  async check(owner: string, keep: boolean): Promise<number> {
    const prev = this.store.snapshot(owner);
    const cur = await this.snapshot(owner, prev);
    if (!cur) {
      if (prev) this.store.dropSnapshot(owner);
      return 0;
    }
    let fanned = 0;
    for (const n of notices(prev, cur, this.ctx)) {
      if (this.store.hasNotice(n.key)) continue;
      const to = this.opts.councilOf ? await withCouncils(recipients(cur, n), (a) => !!this.store.council(a), this.opts.councilOf) : recipients(cur, n);
      if (this.engine.fanOut(n, to)) fanned++;
    }
    const open = !!cur.view.plan.proposal || (cur.withdrawal && !["Confirmed", "Failed"].includes(cur.withdrawal.state));
    if (keep || open) this.store.putSnapshot(owner, cur);
    else this.store.dropSnapshot(owner);
    return fanned;
  }

  async tick(): Promise<{ owners: number; notices: number; errors: number }> {
    await this.refreshTokens();
    const { all, keep } = await this.owners();
    let fanned = 0;
    let errors = 0;
    for (const owner of all) {
      try {
        fanned += await this.check(owner, keep.has(owner));
      } catch (e) {
        errors++;
        this.log("plan read failed; will retry", { owner, error: String(e) });
      }
    }
    return { owners: all.length, notices: fanned, errors };
  }

  /** Is `account` part of `owner`'s plan (any role)? Used to vet watch requests. */
  async isMember(owner: string, account: string): Promise<boolean> {
    const s = await this.snapshot(owner, null).catch(() => null);
    if (!s) return false;
    if (!s.options) s.options = await this.view<Options | null>("get_release_options", { owner }).catch(() => null);
    if (members(s).has(account)) return true;
    // named alternates and the fallback (D17) may receive an unclaimed share
    const rules = await this.view<{ alternates: { recipient: { account_id: string } }[]; fallback: { account_id: string } | null } | null>("get_release_rules", { owner }).catch(() => null);
    return !!rules && (rules.fallback?.account_id === account || rules.alternates.some((a) => a.recipient.account_id === account));
  }
}
