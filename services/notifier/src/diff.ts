// Decides which notifications a plan change deserves. Pure: the caller keeps
// the previous snapshot and the set of keys already handled (so restarts
// don't repeat anything). The notifier only reads chain state; a missed or
// failed notification can never change what the contract does.
//
// Wording rule: Behest never knows why an owner stopped checking in, so no
// text says or implies that anyone died. "Unreachable", "hasn't checked in".

export type Status = "Active" | "Overdue" | "Proposed" | "Waiting" | "Eligible" | "Executing" | "Settled";
export type Audience = "owner" | "guardians" | "heirs" | "delay_signers";
export type TransferState = "Pending" | "Sending" | "Signing" | "Signed" | "Broadcast" | "Confirmed" | "Failed";
export type Asset = "Near" | "Eth" | "Btc" | { Erc20: string } | { Nep141: string };

export interface Transfer {
  heir: string;
  asset: Asset;
  destination?: string;
  amount: string;
  state: TransferState | string;
  failure: string | null;
  attempts: number;
  tx_hash?: string | null;
  eth_tx?: { nonce: number } | null;
}

export interface Proposal {
  id: number;
  proposer?: string;
  created_at_ms?: number;
  approvals: string[];
  rejections?: string[];
  waiting_ends_at_ms: number | null;
  transfers: Transfer[];
}

export interface PlanView {
  status: Status;
  overdue_at_ms: number;
  now_ms: number;
  plan: {
    owner: string;
    last_check_in_ms: number;
    policy: { check_in_interval_ms: number; grace_ms: number; quorum: number; guardians: string[]; heirs: { account_id: string }[] };
    proposal: null | Proposal;
    proposals_opened: number;
  };
}

/** `get_extension` (D18): extension votes on the open proposal. */
export interface ExtensionState {
  proposal_id: number;
  total_ms: number;
  count: number;
  pending: null | { extension_ms: number; reason: string | null; votes: string[] };
}

/** The parts of `get_release_options` the notifier uses (D18, D19). */
export interface Options {
  mode: "Claim" | "Automatic" | "Hybrid";
  hybrid_grace_ms?: number;
  delay_signers: string[];
  delay_quorum: number;
}

/** Everything the notifier read about one plan in one poll. */
export interface Snapshot {
  view: PlanView;
  /** Only read while a proposal is open. */
  extension?: ExtensionState | null;
  options?: Options | null;
  /** The owner's latest vault withdrawal (`get_vault_withdrawal`). */
  withdrawal?: Transfer | null;
  /** Archived (settled) releases, `get_release_history`. Required to tell a settled release from a cancelled one. */
  history?: { id: number; created_at_ms: number }[];
}

export const KINDS = [
  "reminder",
  "overdue",
  "proposed",
  "vote",
  "approved",
  "rejected",
  "cancelled",
  "extension_requested",
  "extended",
  "eligible",
  "transfer_confirmed",
  "transfer_failed",
  "transfer_reissued",
  "transfer_reassigned",
  "settled",
  "withdrawal_confirmed",
  "withdrawal_failed",
  "security",
] as const;
export type Kind = (typeof KINDS)[number];

/** Short descriptions for preference screens and email footers. */
export const KIND_INFO: Record<Kind, { label: string; who: string }> = {
  reminder: { label: "Check-in reminders", who: "owners" },
  overdue: { label: "Owner hasn't checked in", who: "owners, guardians" },
  proposed: { label: "Release proposed", who: "owners, guardians" },
  vote: { label: "Guardian votes", who: "owners, guardians" },
  approved: { label: "Release approved", who: "everyone on the plan" },
  rejected: { label: "Release rejected", who: "owners, guardians" },
  cancelled: { label: "Release cancelled", who: "guardians, heirs" },
  extension_requested: { label: "Delay requested", who: "owners, delay signers" },
  extended: { label: "Waiting period extended", who: "everyone on the plan" },
  eligible: { label: "Ready to receive", who: "heirs" },
  transfer_confirmed: { label: "Transfer arrived", who: "heirs" },
  transfer_failed: { label: "Transfer problem", who: "heirs, guardians" },
  transfer_reissued: { label: "Transfer re-sent", who: "heirs, guardians" },
  transfer_reassigned: { label: "Unclaimed share moved", who: "heirs, guardians" },
  settled: { label: "Release complete", who: "everyone on the plan" },
  withdrawal_confirmed: { label: "Vault withdrawal sent", who: "owners" },
  withdrawal_failed: { label: "Vault withdrawal problem", who: "owners" },
  security: { label: "Changes to your notification channels", who: "you (always on)" },
};

/** Kinds a person can't switch off. */
export const ALWAYS_ON: readonly Kind[] = ["security"];

export interface Link {
  label: string;
  url: string;
}

export interface Notice {
  /** Stable id: the same event never produces two different keys. */
  key: string;
  owner: string;
  kind: Kind;
  to: Audience[];
  /** Extra accounts outside the audiences (e.g. an alternate who now receives). */
  accounts?: string[];
  /** Accounts that caused the event and don't need telling. */
  except?: string[];
  subject: string;
  text: string;
  proposalId?: number;
  transferIndex?: number;
  asset?: string;
  amount?: string;
  txHash?: string;
  links: Link[];
}

export interface Ctx {
  /** Behest web app, for "open the plan" links. */
  appUrl?: string;
  contractId?: string;
  /** Token metadata by ERC-20 address or NEP-141 account. */
  tokens?: Record<string, { symbol: string; decimals: number }>;
}

export const EXPLORERS = {
  near: "https://testnet.nearblocks.io",
  eth: "https://sepolia.etherscan.io",
  btc: "https://mempool.space/testnet4",
};

/** "kemi-1a2b.testnet" → "Kemi"; the friendly first part of an account. */
export const PERSONA_NAMES: Record<string, string> = { owner: "Kemi", g1: "Dayo", g2: "Funmi", g3: "Chidi" };
const name = (a: string) => {
  if (/^0x[0-9a-f]{40}$/i.test(a) || /^[0-9a-f]{64}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  const f = a.split(".")[0] ?? a;
  const r = f.includes("-") ? f.slice(f.lastIndexOf("-") + 1) : f;
  // "Try as…" personas are named by role in the account id; use their names.
  if (a.includes(".demo.") && r in PERSONA_NAMES) return PERSONA_NAMES[r]!;
  return r.charAt(0).toUpperCase() + r.slice(1);
};

/** Reminders once 75% and again once 95% of the check-in window has passed. */
export const REMINDER_AT = 0.75;
export const LAST_REMINDER_AT = 0.95;

/** Failures the executor retries by itself (services/executor/src/engine.ts AUTO_RETRY). */
const AUTO_RETRY = new Set(["SignFailed", "Stuck", "Underpriced", "FeeAboveCap", "Dropped", "BadSignature"]);
/** Bookkeeping states that aren't news to anyone. */
const SILENT_FAILURES = new Set(["Rechained"]);

const FAILURE_TEXT: Record<string, string> = {
  Stuck: "is waiting on the network longer than expected; Behest will raise the fee and try again",
  Dropped: "was dropped by the network; Behest will send it again",
  Underpriced: "was priced below the network fee; Behest will try again",
  FeeAboveCap: "is waiting for network fees to fall below the plan's cap; Behest will keep trying",
  SignFailed: "couldn't be signed this time; Behest will try again",
  BadSignature: "couldn't be signed this time; Behest will try again",
  Reverted: "was rejected by the token contract. This is proven on-chain, so it will be re-sent under a new transaction",
  Conflict: "can't be sent because a vault coin was spent elsewhere. A guardian needs to refresh the Bitcoin coins in Behest",
};

export function assetLabel(a: Asset, ctx: Ctx = {}): string {
  if (typeof a === "string") return a.toUpperCase();
  const id = "Erc20" in a ? a.Erc20 : a.Nep141;
  return ctx.tokens?.[id]?.symbol ?? ("Erc20" in a ? "ERC-20 token" : "NEAR token");
}

function decimals(a: Asset, ctx: Ctx): number | null {
  if (a === "Near") return 24;
  if (a === "Eth") return 18;
  if (a === "Btc") return 8;
  const id = "Erc20" in a ? a.Erc20 : a.Nep141;
  return ctx.tokens?.[id]?.decimals ?? null;
}

/** Integer base units → a short decimal string (at most 6 decimals, trailing zeros trimmed). */
export function formatAmount(raw: string, a: Asset, ctx: Ctx = {}): string {
  const d = decimals(a, ctx);
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    return raw;
  }
  if (d === null) return `${raw} units of`;
  const base = 10n ** BigInt(d);
  const whole = v / base;
  const frac = (v % base).toString().padStart(d, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Explorer link for a transfer's transaction, when the chain view has one. */
export function txLink(a: Asset, hash: string | null | undefined): Link | null {
  if (!hash) return null;
  if (a === "Btc") return { label: "View on mempool.space", url: `${EXPLORERS.btc}/tx/${hash}` };
  if (a === "Eth" || (typeof a === "object" && "Erc20" in a)) {
    const h = hash.startsWith("0x") ? hash : `0x${hash}`;
    return { label: "View on Etherscan (Sepolia)", url: `${EXPLORERS.eth}/tx/${h}` };
  }
  return { label: "View on NEAR Blocks", url: `${EXPLORERS.near}/txns/${hash}` };
}

const when = (ms: number) => new Date(ms).toUTCString();

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(ms / 86_400_000);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function notices(prev: Snapshot | null, cur: Snapshot, ctx: Ctx = {}): Notice[] {
  const out: Notice[] = [];
  const v = cur.view;
  const o = v.plan.owner;
  const who = name(o);
  const p = v.plan.proposal;
  const planLink: Link[] = ctx.appUrl ? [{ label: "Open the plan in Behest", url: `${ctx.appUrl.replace(/\/$/, "")}/plan/${o}` }] : [];
  // The heir recovery packet: claim steps with and without Behest's website.
  const packetLink: Link[] = ctx.appUrl ? [{ label: "How to claim (recovery packet)", url: `${ctx.appUrl.replace(/\/$/, "")}/plan/${o}/packet` }] : [];
  const add = (n: Omit<Notice, "owner" | "links"> & { links?: Link[] }) => out.push({ ...n, owner: o, links: [...(n.links ?? []), ...planLink] });
  const window = v.plan.policy.check_in_interval_ms + v.plan.policy.grace_ms;
  const checkIn = v.plan.last_check_in_ms; // each check-in gets its own keys

  // ---- check-ins
  if (v.status === "Active" && v.now_ms >= v.overdue_at_ms - window * (1 - REMINDER_AT)) {
    add({ key: `${o}:reminder:${checkIn}`, kind: "reminder", to: ["owner"], subject: "Time to check in", text: `Reminder: check in before ${when(v.overdue_at_ms)} so your guardians aren't asked to act.` });
  }
  if (v.status === "Active" && v.now_ms >= v.overdue_at_ms - window * (1 - LAST_REMINDER_AT)) {
    add({ key: `${o}:reminder2:${checkIn}`, kind: "reminder", to: ["owner"], subject: "Last reminder to check in", text: `Last reminder: your check-in window ends ${when(v.overdue_at_ms)}. After that your guardians are told you're unreachable.` });
  }
  if (v.status === "Overdue") {
    add({
      key: `${o}:overdue:${checkIn}`,
      kind: "overdue",
      to: ["owner", "guardians"],
      subject: `${who} hasn't checked in`,
      text: `${who} hasn't checked in and is now counted as unreachable. Guardians can propose a release; ${who} can still check in.`,
    });
  }

  // ---- the open proposal
  if (p) {
    const followUp = (cur.history ?? []).some((h) => h.id !== p.id && h.created_at_ms > checkIn);
    const proposer = p.proposer ? [p.proposer] : [];
    // Each notice is sent only while it is still true: a plan first seen after
    // approval gets the approval, not a stale "proposed" (or a "can cancel until"
    // that already passed).
    const waitingNow = v.status === "Waiting";
    if (!p.waiting_ends_at_ms) {
      add({
        key: `${o}:proposed:${p.id}`,
        kind: "proposed",
        // a follow-up round can be started by an heir, and concerns all of them
        to: followUp ? ["owner", "guardians", "heirs"] : ["owner", "guardians"],
        except: proposer,
        proposalId: p.id,
        subject: followUp ? `Follow-up release proposed for ${who}'s plan` : `Release proposed for ${who}'s plan`,
        text: followUp
          ? `${p.proposer ? name(p.proposer) : "Someone"} proposed a follow-up release (#${p.id}) of what is still in ${who}'s plan. ${v.plan.policy.quorum} guardian approvals are needed. ${who} can cancel.`
          : `A release of ${who}'s plan was proposed (#${p.id})${p.proposer ? ` by ${name(p.proposer)}` : ""}. ${v.plan.policy.quorum} guardian approvals are needed. ${who} can cancel.`,
      });
      // votes before the quorum; the vote that reaches it is the approval notice
      const n = p.approvals.length;
      for (const g of p.approvals) {
        if (g === p.proposer) continue;
        add({
          key: `${o}:vote:${p.id}:${g}`,
          kind: "vote",
          to: ["owner", "guardians"],
          except: [g],
          proposalId: p.id,
          subject: `${name(g)} approved release #${p.id}`,
          text: `${name(g)} approved release #${p.id} of ${who}'s plan (${n} of ${v.plan.policy.quorum} approvals so far).`,
        });
      }
      for (const g of p.rejections ?? []) {
        add({
          key: `${o}:vote:${p.id}:${g}`,
          kind: "vote",
          to: ["owner", "guardians"],
          except: [g],
          proposalId: p.id,
          subject: `${name(g)} rejected release #${p.id}`,
          text: `${name(g)} rejected release #${p.id} of ${who}'s plan. It closes if too few guardians are left to approve it.`,
        });
      }
    }
    if (p.waiting_ends_at_ms && waitingNow) {
      add({
        key: `${o}:approved:${p.id}`,
        kind: "approved",
        to: ["owner", "guardians", "heirs", "delay_signers"],
        proposalId: p.id,
        subject: `Release #${p.id} of ${who}'s plan was approved`,
        text: `Release #${p.id} of ${who}'s plan was approved. ${who} can cancel until ${when(p.waiting_ends_at_ms)}; nothing is sent before then.`,
      });
    }
    // Delay signers (D18).
    const ext = cur.extension && cur.extension.proposal_id === p.id ? cur.extension : null;
    if (ext?.pending && p.waiting_ends_at_ms && waitingNow) {
      const by = ext.pending.votes[0];
      const reason = ext.pending.reason ? ` Reason given: "${ext.pending.reason}".` : "";
      const q = cur.options?.delay_quorum;
      add({
        key: `${o}:extension_requested:${p.id}:${ext.count}:${ext.pending.extension_ms}:${by ?? ""}`,
        kind: "extension_requested",
        to: ["owner", "delay_signers"],
        except: by ? [by] : [],
        proposalId: p.id,
        subject: `Delay requested for release #${p.id}`,
        text: `${by ? name(by) : "A delay signer"} asked to extend the waiting period of release #${p.id} of ${who}'s plan by ${duration(ext.pending.extension_ms)}.${reason} It applies once ${q ?? "enough"} delay signers agree.`,
      });
    }
    const before = prev?.view.plan.proposal;
    const grew = !!p.waiting_ends_at_ms && before?.id === p.id && !!before.waiting_ends_at_ms && p.waiting_ends_at_ms > before.waiting_ends_at_ms;
    if (p.waiting_ends_at_ms && waitingNow && (grew || (ext?.count ?? 0) > 0)) {
      add({
        key: `${o}:extended:${p.id}:${p.waiting_ends_at_ms}`,
        kind: "extended",
        to: ["owner", "guardians", "heirs", "delay_signers"],
        proposalId: p.id,
        subject: `Waiting period of release #${p.id} extended`,
        text: `Delay signers extended the waiting period of release #${p.id}. ${who} can now cancel until ${when(p.waiting_ends_at_ms)}; heirs can receive after that.`,
      });
    }
    if (v.status === "Eligible" || v.status === "Executing") {
      const mode = cur.options?.mode ?? "Claim";
      const how =
        mode === "Automatic"
          ? "It is being sent to you automatically; you don't need to do anything."
          : mode === "Hybrid"
            ? `Open Behest to receive it, or it will be sent to you automatically${cur.options?.hybrid_grace_ms ? ` after ${duration(cur.options.hybrid_grace_ms)}` : ""}.`
            : "Open Behest to receive it.";
      add({ key: `${o}:eligible:${p.id}`, kind: "eligible", to: ["heirs"], proposalId: p.id, subject: `${who}'s plan is ready for you`, text: `What ${who} set aside for you is ready. ${how} Network fees are covered.`, links: packetLink });
    }
    p.transfers.forEach((t, i) => {
      const asset = assetLabel(t.asset, ctx);
      const amount = formatAmount(t.amount, t.asset, ctx);
      const link = txLink(t.asset, t.tx_hash);
      const links = link ? [link] : [];
      const base = { proposalId: p.id, transferIndex: i, asset, amount, txHash: t.tx_hash ?? undefined, links };
      if (t.state === "Confirmed") {
        add({
          ...base,
          key: `${o}:confirmed:${p.id}:${i}`,
          kind: "transfer_confirmed",
          to: [],
          accounts: [t.heir],
          subject: `${amount} ${asset} from ${who}'s plan arrived`,
          text: `${amount} ${asset} from ${who}'s plan arrived${t.destination ? ` at ${t.destination}` : ""}.`,
        });
      }
      if (t.state === "Failed" && t.failure && !SILENT_FAILURES.has(t.failure)) {
        // automatic retries are told once per reason, anything else once per attempt
        const key = AUTO_RETRY.has(t.failure) ? `${o}:failed:${p.id}:${i}:${t.failure}` : `${o}:failed:${p.id}:${i}:${t.attempts}:${t.failure}`;
        const what = FAILURE_TEXT[t.failure] ?? `didn't go through (${t.failure}). A guardian can retry it from Behest`;
        add({
          ...base,
          key,
          kind: "transfer_failed",
          to: ["guardians"],
          accounts: [t.heir],
          subject: `A transfer from ${who}'s plan needs attention`,
          text: `${name(t.heir)}'s ${amount} ${asset} transfer from ${who}'s plan ${what}. The funds are safe in the vault.`,
        });
      }
      // D22: a proven revert was re-issued under a new nonce.
      const was = before?.id === p.id ? before.transfers[i] : undefined;
      if (was && was.state === "Failed" && was.failure === "Reverted" && t.state !== "Failed" && (t.eth_tx?.nonce ?? -1) !== (was.eth_tx?.nonce ?? -1)) {
        add({
          ...base,
          key: `${o}:reissued:${p.id}:${i}:${t.eth_tx?.nonce ?? t.attempts}`,
          kind: "transfer_reissued",
          to: ["guardians"],
          accounts: [t.heir],
          subject: `A transfer from ${who}'s plan was re-sent`,
          text: `${name(t.heir)}'s ${amount} ${asset} transfer from ${who}'s plan reverted on Sepolia. The revert was proven on-chain, so it is being sent again as a new transaction. It can only pay once.`,
        });
      }
      // D17: an unclaimed share moved to the heir's alternate or the plan's fallback.
      if (was && was.heir !== t.heir) {
        add({
          ...base,
          key: `${o}:reassigned:${p.id}:${i}:${t.heir}`,
          kind: "transfer_reassigned",
          to: ["guardians"],
          accounts: [was.heir, t.heir],
          subject: `An unclaimed share of ${who}'s plan moved`,
          text: `${name(was.heir)}'s ${amount} ${asset} from ${who}'s plan wasn't claimed in time, so it now goes to ${name(t.heir)}, as ${who}'s rules say.`,
        });
      }
    });
    if (v.status === "Settled") {
      add({
        key: `${o}:settled:${p.id}`,
        kind: "settled",
        to: ["owner", "guardians", "heirs"],
        proposalId: p.id,
        subject: `Release #${p.id} of ${who}'s plan is complete`,
        text: `Every transfer of release #${p.id} of ${who}'s plan has arrived. Receipts are in Behest.`,
      });
    }
  }

  // ---- a proposal that disappeared: archived (settled), cancelled by the owner, or rejected
  const prevP = prev?.view.plan.proposal;
  if (prev && prevP && (!p || p.id !== prevP.id) && cur.history) {
    const approved = !!prevP.waiting_ends_at_ms;
    if (cur.history.some((h) => h.id === prevP.id)) {
      add({
        key: `${o}:settled:${prevP.id}`,
        kind: "settled",
        to: ["owner", "guardians", "heirs"],
        proposalId: prevP.id,
        subject: `Release #${prevP.id} of ${who}'s plan is complete`,
        text: `Every transfer of release #${prevP.id} of ${who}'s plan has arrived. Receipts are in Behest.`,
      });
    } else if (v.plan.last_check_in_ms > prev.view.plan.last_check_in_ms || approved) {
      // cancel_release and check_in both record a check-in; rejection can't happen after approval
      add({
        key: `${o}:cancelled:${prevP.id}`,
        kind: "cancelled",
        to: approved ? ["guardians", "heirs", "delay_signers"] : ["guardians"],
        accounts: prevP.proposer ? [prevP.proposer] : [],
        proposalId: prevP.id,
        subject: `${who} cancelled release #${prevP.id}`,
        text: `${who} is reachable again and cancelled release #${prevP.id}. Nothing was sent.`,
      });
    } else {
      add({
        key: `${o}:rejected:${prevP.id}`,
        kind: "rejected",
        to: ["owner", "guardians"],
        accounts: prevP.proposer ? [prevP.proposer] : [],
        proposalId: prevP.id,
        subject: `Release #${prevP.id} of ${who}'s plan was rejected`,
        text: `Guardians rejected release #${prevP.id} of ${who}'s plan, so too few are left to approve it. Nothing was sent and the plan is unchanged.`,
      });
    }
  }

  // ---- the owner's own vault withdrawal (D7, D20)
  // Only a change since the last look is news (an old withdrawal on first sight isn't).
  const pw = prev?.withdrawal;
  const cw = cur.withdrawal;
  const changed = prev && pw !== undefined && cw && (!pw || pw.state !== cw.state || pw.tx_hash !== cw.tx_hash || pw.attempts !== cw.attempts || pw.failure !== cw.failure);
  const w = changed ? cw : null;
  if (w) {
    const asset = assetLabel(w.asset, ctx);
    const amount = formatAmount(w.amount, w.asset, ctx);
    const link = txLink(w.asset, w.tx_hash);
    const base = { to: ["owner"] as Audience[], asset, amount, txHash: w.tx_hash ?? undefined, links: link ? [link] : [] };
    const id = w.tx_hash ?? `${w.eth_tx?.nonce ?? "n"}:${w.destination ?? ""}:${w.amount}`;
    if (w.state === "Confirmed") {
      add({
        ...base,
        key: `${o}:withdrawal:${id}:confirmed`,
        kind: "withdrawal_confirmed",
        subject: `Your ${asset} withdrawal arrived`,
        text: `Your withdrawal of ${amount} ${asset} from the plan's vault arrived${w.destination ? ` at ${w.destination}` : ""}.`,
      });
    } else if (w.state === "Failed" && w.failure && !SILENT_FAILURES.has(w.failure)) {
      const what = FAILURE_TEXT[w.failure] ?? `didn't go through (${w.failure}). You can retry or cancel it in Behest`;
      add({
        ...base,
        key: `${o}:withdrawal:${id}:${AUTO_RETRY.has(w.failure) ? "" : w.attempts}:${w.failure}`,
        kind: "withdrawal_failed",
        subject: `Your ${asset} withdrawal needs attention`,
        text: `Your withdrawal of ${amount} ${asset} ${what}. The funds are safe in the vault.`,
      });
    }
  }
  return out;
}

/** Account ids a notice goes to, minus whoever caused it. */
export function recipients(s: Snapshot, n: Pick<Notice, "to" | "accounts" | "except">): string[] {
  const v = s.view;
  const r = new Set<string>();
  if (n.to.includes("owner")) r.add(v.plan.owner);
  if (n.to.includes("guardians")) v.plan.policy.guardians.forEach((g) => r.add(g));
  if (n.to.includes("heirs")) v.plan.policy.heirs.forEach((h) => r.add(h.account_id));
  if (n.to.includes("delay_signers")) (s.options?.delay_signers ?? []).forEach((d) => r.add(d));
  (n.accounts ?? []).forEach((a) => r.add(a));
  (n.except ?? []).forEach((a) => r.delete(a));
  return [...r];
}

/** Every account with a role in the plan (used to decide whose watch requests to honour). */
export function members(s: Snapshot): Set<string> {
  return new Set(recipients(s, { to: ["owner", "guardians", "heirs", "delay_signers"], accounts: s.view.plan.proposal?.transfers.map((t) => t.heir) ?? [] }));
}
