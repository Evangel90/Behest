// Pure plan logic for the UI: plain-language summaries, roles, what each person
// can do right now, and display formatting. No I/O, so it's unit-tested.
import type { PlanInput, PlanStatus, PlanView, Recipient, ReleaseOptions, ReleaseRules, Transfer, TransferState, Asset, Erc20Token, Nep141Token } from "./types";

export type Role = "owner" | "guardian" | "heir";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function duration(ms: number): string {
  if (ms <= 0) return "no time";
  const unit = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  if (ms % DAY === 0) return unit(ms / DAY, "day");
  if (ms % HOUR === 0) return unit(ms / HOUR, "hour");
  if (ms >= MIN) return unit(Math.round(ms / MIN), "minute");
  return unit(Math.round(ms / 1000), "second");
}

/** "in 3 minutes" / "2 days ago" relative to the chain clock. */
/** A moment, unambiguous in every locale: "9 Nov 2026, 00:30". */
export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A day: "9 Nov 2026". */
export function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function relative(target: number, now: number): string {
  const d = target - now;
  const abs = Math.abs(d);
  const s = abs < MIN ? `${Math.max(1, Math.round(abs / 1000))} s` : abs < HOUR ? `${Math.round(abs / MIN)} min` : abs < DAY ? `${Math.round(abs / HOUR)} h` : `${Math.round(abs / DAY)} days`;
  return d >= 0 ? `in ${s}` : `${s} ago`;
}

const PERSONA_NAMES: Record<string, string> = { owner: "Kemi", g1: "Dayo", g2: "Funmi", g3: "Chidi" };

export function shortName(account: string): string {
  // Ethereum-wallet accounts (0x…): the short address, as wallets show it.
  if (/^0x[0-9a-fA-F]{40}$/.test(account)) return shortAddr(account.toLowerCase());
  const first = account.split(".")[0] ?? account;
  // D26: a SputnikDAO keeps its whole name ("bh-ekkr6" and "bg-ekkr6" are different DAOs).
  if (/\.(sputnikv2\.testnet|sputnik-dao\.near)$/.test(account)) return `${first} DAO`;
  // persona accounts look like "x7f2-amara.demo…": show "Amara"
  const role = first.includes("-") ? first.slice(first.lastIndexOf("-") + 1) : first;
  // "Try as…" personas are named by role in the account id; show their names.
  if (account.includes(".demo.") && role in PERSONA_NAMES) return PERSONA_NAMES[role]!;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function percent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** The whole rule in one paragraph, as the owner and guardians should read it. */
export function describePlan(p: PlanInput, ownerLabel = "you"): string {
  const you = ownerLabel === "you";
  const heirs = p.heirs.some((h) => h.account_id) ? listNames(p.heirs.filter((h) => h.account_id).map((h) => shortName(h.account_id))) : you ? "your heirs" : "the heirs";
  const grace = p.grace_ms > 0 ? ` plus ${duration(p.grace_ms)} of grace` : "";
  return [
    `If ${you ? "you don't" : `${ownerLabel} doesn't`} check in for ${duration(p.check_in_interval_ms)}${grace}, ${p.guardians.length ? `any ${p.quorum} of ${p.guardians.length} guardians` : "your guardians"} may propose a release.`,
    `A waiting period of ${duration(p.waiting_period_ms)} follows, during which ${you ? "you" : ownerLabel} can cancel.`,
    `Then ${heirs} receive${p.heirs.filter((h) => h.account_id).length === 1 ? "s" : ""} their shares at the fixed addresses below. Nobody can change where funds go.`,
  ].join(" ");
}

export function rolesOf(view: PlanView | null, account: string | null): Role[] {
  if (!view || !account) return [];
  const r: Role[] = [];
  if (view.plan.owner === account) r.push("owner");
  if (view.plan.policy.guardians.includes(account)) r.push("guardian");
  // An alternate or the fallback acts as a heir once a share was reassigned to them.
  if (view.plan.policy.heirs.some((h) => h.account_id === account) || view.plan.proposal?.transfers.some((t) => t.heir === account)) r.push("heir");
  return r;
}

export interface Actions {
  can: string[];
  cant: string[];
}

/** "Can act now / Can't" rows for a status card. */
/**
 * D21: a follow-up round is open to heirs (guardians may always propose once
 * the owner is overdue) when a release settled and the owner hasn't checked
 * in since. `lastSettledAt` is when that release was proposed.
 */
export function followUpOpen(view: PlanView, lastSettledAt: number | null): boolean {
  if (view.status !== "Settled" && view.status !== "Overdue") return false;
  return lastSettledAt != null && lastSettledAt > view.plan.last_check_in_ms;
}

export function actionsFor(view: PlanView, role: Role | "public", account?: string, followUp = false): Actions {
  const s = view.status;
  const p = view.plan.proposal;
  const voted = !!account && !!p && (p.approvals.includes(account) || p.rejections.includes(account));
  switch (role) {
    case "owner":
      if (s === "Active" || s === "Overdue") return { can: ["Check in", "Edit the plan", "Add or withdraw NEAR"], cant: ["Guardians can't propose while you're current"].slice(s === "Active" ? 0 : 1) };
      if (s === "Proposed" || s === "Waiting") return { can: ["Cancel the release", "Check in (also cancels)"], cant: ["Edit the plan or withdraw while a release is open"] };
      if (s === "Settled") return { can: ["Check in to take the plan back", "Withdraw what is left"], cant: ["Undo the completed release"] };
      return { can: [], cant: ["Cancel: the waiting period is over", "Change recipients or amounts"] };
    case "guardian":
      if (s === "Active") return { can: [], cant: ["Propose a release while the owner is checking in"] };
      if (s === "Overdue") return { can: [followUp ? "Propose a follow-up release" : "Propose a release"], cant: ["Choose recipients or amounts"] };
      if (s === "Settled") return { can: ["Propose a follow-up release for anything left"], cant: ["Choose recipients or amounts"] };
      if (s === "Proposed") return voted ? { can: [], cant: ["Vote twice on the same proposal"] } : { can: ["Approve or reject this exact proposal"], cant: ["Change what it pays out"] };
      return { can: [], cant: ["Stop the release: only the owner can, until the waiting period ends"] };
    case "heir":
      if (s === "Eligible" || s === "Executing") return { can: ["Receive your share"], cant: ["Change the destination"] };
      if (followUp) return { can: ["See your receipts", "Start a follow-up release for anything left"], cant: ["Approve it: guardians do"] };
      if (s === "Settled") return { can: ["See your receipts"], cant: [] };
      return { can: [], cant: ["Receive anything yet"] };
    default:
      return { can: ["Read the rules and every transfer"], cant: ["Change anything"] };
  }
}

export const LIFECYCLE: PlanStatus[] = ["Active", "Overdue", "Proposed", "Waiting", "Eligible", "Executing", "Settled"];

/** Chip look per state: tinted tone + a dot shape that tells states apart without colour. */
export interface ChipStyle {
  tone: "active" | "overdue" | "proposed" | "approved" | "waiting" | "eligible" | "signing" | "broadcast" | "cancelled" | "failed" | "partial";
  shape: "circle" | "square" | "diamond";
  label: string;
}

export const STATUS_STYLE: Record<PlanStatus, ChipStyle> = {
  Active: { tone: "active", shape: "circle", label: "Active" },
  Overdue: { tone: "overdue", shape: "square", label: "Owner unreachable" },
  Proposed: { tone: "proposed", shape: "diamond", label: "Release proposed" },
  Waiting: { tone: "waiting", shape: "square", label: "Waiting period" },
  Eligible: { tone: "eligible", shape: "diamond", label: "Ready to receive" },
  Executing: { tone: "signing", shape: "circle", label: "Sending" },
  Settled: { tone: "active", shape: "diamond", label: "Complete" },
};

export const TRANSFER_STYLE: Record<TransferState, ChipStyle> = {
  Pending: { tone: "cancelled", shape: "square", label: "Not started" },
  Sending: { tone: "signing", shape: "circle", label: "Sending" },
  Signing: { tone: "signing", shape: "circle", label: "Signing" },
  Signed: { tone: "approved", shape: "circle", label: "Signed" },
  Broadcast: { tone: "broadcast", shape: "circle", label: "On its way" },
  Confirmed: { tone: "active", shape: "diamond", label: "Received" },
  Failed: { tone: "failed", shape: "diamond", label: "Needs a retry" },
};

/** Why a transfer failed, in words an heir can act on. Funds never leave the vault on failure. */
export function failureText(t: Transfer): string {
  switch (t.failure) {
    case "IntentsRefunded":
      return "NEAR Intents handed the payment back, so nothing counts as paid. It's back in the plan; retry to send it again.";
    case "IntentsPartlyRefunded":
      return "NEAR Intents kept part of the payment and handed the rest back. What arrived counts; a retry sends only the rest.";
    case "Underpriced":
    case "FeeAboveCap":
      return "Network fees were too high. It will be retried automatically; your share is safe.";
    case "Stuck":
    case "Dropped":
      return "The network didn't pick it up. It will be retried automatically; your share is safe.";
    case "GasLimitTooLow":
      return "The network now needs more gas for this transfer. An operator has to raise the limit; your share is safe.";
    case "WouldRevert":
      return `The vault doesn't hold enough ${assetLabel(t.asset)} for this transfer right now, so nothing was sent. Your other transfers aren't affected. Retry once the vault is topped up; your share is safe.`;
    case "Reverted":
      return "The network rejected the transaction. An operator has to re-issue it; your share is safe.";
    case "Rechained":
      return "An earlier Bitcoin payout went through at its original fee, so this one is being rebuilt on top of it. It will be retried automatically; your share is safe.";
    case "Conflict":
      return "A vault coin was spent by something else. A guardian has to point the release at the vault's current coins; your share is safe.";
    default:
      return t.failure ? `Failed (${t.failure}). You can retry; your share is safe.` : "";
  }
}

const NEAR = 10n ** 24n;
const ETH = 10n ** 18n;
function fmt(value: bigint, unit: bigint, digits: number): string {
  const whole = value / unit;
  const frac = (value % unit).toString().padStart(unit.toString().length - 1, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
export const formatNear = (yocto: string | bigint, digits = 4) => fmt(BigInt(yocto), NEAR, digits);
export const formatEth = (wei: string | bigint, digits = 6) => fmt(BigInt(wei), ETH, digits);

// Allowlisted tokens, filled from the contract config on first read.
let TOKENS: Erc20Token[] = [];
let FTS: Nep141Token[] = [];
export const registerTokens = (tokens: Erc20Token[], fts: Nep141Token[] = []) => void ((TOKENS = tokens), (FTS = fts));
export const BTC = { symbol: "BTC", decimals: 8 } as const;
export const tokenOf = (asset: Asset): Pick<Erc20Token, "symbol" | "decimals"> | undefined => {
  if (asset === "Btc") return BTC;
  if (typeof asset !== "object") return undefined;
  if ("Erc20" in asset) return TOKENS.find((t) => t.address === asset.Erc20.toLowerCase());
  return FTS.find((t) => t.account_id === asset.Nep141);
};
export const isEvm = (asset: Asset) => asset === "Eth" || (typeof asset === "object" && "Erc20" in asset);
export const isBtc = (asset: Asset) => asset === "Btc";
export function assetLabel(asset: Asset): string {
  if (asset === "Near") return "NEAR";
  if (asset === "Eth") return "ETH";
  if (asset === "Btc") return "BTC";
  const id = "Erc20" in asset ? asset.Erc20.slice(0, 8) + "…" : asset.Nep141;
  return tokenOf(asset)?.symbol ?? `token ${id}`;
}
export function formatToken(amount: string | bigint, token: Pick<Erc20Token, "decimals">, digits = 6) {
  return fmt(BigInt(amount), 10n ** BigInt(token.decimals), digits);
}
export function formatAmount(t: Pick<Transfer, "asset" | "amount">): string {
  if (t.asset === "Near") return `${formatNear(t.amount)} NEAR`;
  if (t.asset === "Eth") return `${formatEth(t.amount)} ETH`;
  const tok = tokenOf(t.asset);
  return tok ? `${formatToken(t.amount, tok)} ${tok.symbol}` : `${t.amount} (raw) ${assetLabel(t.asset)}`;
}

/**
 * What a proposal made now would distribute from the ETH vault. Mirrors
 * `propose_release`: one max-fee reserve per vault transaction; token
 * transfers are funded first, ETH is split only if what's left also covers
 * the ETH transfers. `error` matches the contract's refusal.
 */
export function vaultSplit(opts: { ethHeirs: number; ethBalance: bigint; tokenBalances: bigint[]; gasLimit: number; feeCap: bigint }) {
  const heirs = BigInt(opts.ethHeirs);
  const perTx = BigInt(opts.gasLimit) * opts.feeCap;
  const tokens = opts.tokenBalances.filter((b) => b > 0n).length;
  const tokenTxs = heirs > 0n ? heirs * BigInt(tokens) : 0n;
  const tokenReserve = tokenTxs * perTx;
  if (opts.ethBalance < tokenReserve) return { error: "E_INSUFFICIENT_FEE_RESERVE" as const, reserve: tokenReserve, ethToSplit: 0n, transfers: Number(tokenTxs) };
  const after = opts.ethBalance - tokenReserve;
  const ethReserve = heirs * perTx;
  if (heirs > 0n && after > ethReserve) return { reserve: tokenReserve + ethReserve, ethToSplit: after - ethReserve, transfers: Number(tokenTxs + heirs) };
  if (heirs > 0n && opts.ethBalance > 0n && tokenTxs === 0n) return { error: "E_INSUFFICIENT_FEE_RESERVE" as const, reserve: ethReserve, ethToSplit: 0n, transfers: Number(heirs) };
  return { reserve: tokenReserve, ethToSplit: 0n, transfers: Number(tokenTxs) };
}

export const formatBtc = (sats: string | bigint | number) => fmt(BigInt(sats), 100_000_000n, 8);

/** Testnet SegWit address check (format only; the contract verifies the checksum). */
export const looksLikeBtcAddress = (a: string) => /^tb1[qp][02-9ac-hj-np-z]{38,58}$/.test(a.trim());

/**
 * Bitcoin vault payouts a proposal would make. Mirrors `propose_release`:
 * the reserve pays every payout at the fee-rate cap (the first spends the
 * reported coins, each later one a single change output); the rest is split.
 */
export function btcSplit(opts: { heirs: number; inputs: number; total: bigint; maxFeeRate: number }) {
  if (opts.heirs === 0 || opts.inputs === 0) return { reserve: 0n, toSplit: 0n };
  const reserve = btcPayoutFees({ heirs: opts.heirs, inputs: opts.inputs, feeRate: opts.maxFeeRate });
  if (opts.total <= reserve) return { reserve, toSplit: 0n, error: "E_INSUFFICIENT_FEE_RESERVE" as const };
  return { reserve, toSplit: opts.total - reserve };
}

export function parseNear(text: string): bigint {
  const [w = "0", f = ""] = text.trim().split(".");
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f) || f.length > 24) throw new Error("not a NEAR amount");
  return BigInt(w || "0") * NEAR + BigInt((f + "0".repeat(24)).slice(0, 24));
}

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Validates a draft plan the same way the contract does (subset), for inline errors. */
export function validateDraft(p: PlanInput, owner: string): string[] {
  const errs: string[] = [];
  const total = p.heirs.reduce((s, h) => s + h.share_bps, 0);
  if (p.heirs.length === 0) errs.push("Add at least one heir.");
  if (total !== 10_000) errs.push(`Shares add up to ${percent(total)}; they must add up to 100%.`);
  if (p.guardians.length === 0) errs.push("Add at least one guardian.");
  if (p.quorum < 1 || p.quorum > p.guardians.length) errs.push("The number of approvals needed must be between 1 and the number of guardians.");
  if (new Set(p.guardians).size !== p.guardians.length) errs.push("A guardian is listed twice.");
  for (const h of p.heirs) {
    if (!h.near_destination && !h.eth_destination) errs.push(`${shortName(h.account_id) || "An heir"} needs a NEAR or Ethereum destination.`);
    if (h.eth_destination && !/^0x[0-9a-fA-F]{40}$/.test(h.eth_destination)) errs.push(`${shortName(h.account_id)}'s Ethereum address isn't valid.`);
    if (p.guardians.includes(h.account_id)) errs.push(`${shortName(h.account_id)} can't be both an heir and a guardian.`);
    if (h.account_id === owner) errs.push("You can't be your own heir.");
  }
  if (p.guardians.includes(owner)) errs.push("You can't be your own guardian.");
  return errs;
}

// ------------------------------------------------------------ release rules

const receives = (r: Recipient, asset: Asset, btcDests: string[] = []) =>
  isBtc(asset) ? btcDests.includes(r.account_id) : (isEvm(asset) ? r.eth_destination : r.near_destination) != null;

/**
 * Who an unclaimed transfer can be moved to, and from when. Mirrors
 * `reassign_unclaimed`: a heir's transfer goes to their alternate (or the
 * fallback if the alternate can't receive this asset) one claim window after
 * the plan became claimable; an alternate's goes to the fallback a window later.
 */
export function nextHolder(view: PlanView, rules: ReleaseRules | null, t: Transfer, btcDests: string[] = []): { to: Recipient; from_ms: number } | null {
  const start = view.plan.proposal?.waiting_ends_at_ms;
  if (!rules || start == null || t.state !== "Pending") return null;
  const fallback = rules.fallback && receives(rules.fallback, t.asset, btcDests) ? rules.fallback : null;
  if (view.plan.policy.heirs.some((h) => h.account_id === t.heir)) {
    const alt = rules.alternates.find((a) => a.heir === t.heir)?.recipient;
    const to = alt && receives(alt, t.asset, btcDests) ? alt : fallback;
    return to ? { to, from_ms: start + rules.claim_window_ms } : null;
  }
  if (rules.alternates.some((a) => a.recipient.account_id === t.heir) && fallback) return { to: fallback, from_ms: start + 2 * rules.claim_window_ms };
  return null;
}

/** Plain-language lines for a plan's release rules. */
export function describeRules(rules: ReleaseRules | null): string[] {
  if (!rules) return [];
  const out: string[] = [];
  for (const f of rules.fixed) out.push(`${shortName(f.heir)} receives ${formatAmount({ asset: f.asset, amount: f.amount })} first, before shares are split.`);
  if (rules.remainder_to) out.push(`Rounding leftovers go to ${shortName(rules.remainder_to)}.`);
  for (const a of rules.alternates) out.push(`If ${shortName(a.heir)} doesn't claim within ${duration(rules.claim_window_ms)}, their share goes to ${a.recipient.account_id}.`);
  if (rules.fallback) out.push(`Anything still unclaimed after that goes to ${rules.fallback.account_id}.`);
  return out;
}

export type AssetGroup = "Near" | "Ethereum" | "Bitcoin";

/**
 * The release mode for one heir and asset group, as the contract decides it
 * (`policy::mode_for`): the first override naming this heir (or every heir)
 * and covering the group wins, otherwise the plan's mode. No options = Claim.
 */
export function modeFor(o: ReleaseOptions | null | undefined, heir: string, group: AssetGroup): { mode: ReleaseOptions["mode"]; grace_ms: number } {
  if (!o) return { mode: "Claim", grace_ms: 0 };
  const x = (o.overrides ?? []).find((v) => (v.heir === null || v.heir === heir) && (v.assets === "All" || v.assets === group));
  return x ? { mode: x.mode, grace_ms: x.hybrid_grace_ms } : { mode: o.mode, grace_ms: o.hybrid_grace_ms };
}

/** Plain-language lines for release mode and delay signers. */
export function describeOptions(o: ReleaseOptions | null): string[] {
  const out: string[] = [];
  if (!o || o.mode === "Claim") out.push("Each heir starts their own transfers by claiming.");
  else if (o.mode === "Automatic") out.push("Transfers start automatically as soon as the waiting period ends. Heirs don't need to do anything.");
  else out.push(`Heirs have ${duration(o.hybrid_grace_ms)} after the waiting period to claim; after that, transfers start automatically.`);
  for (const x of o?.overrides ?? []) {
    const who = x.heir ? `${shortName(x.heir)}'s` : "Every heir's";
    const what =
      x.assets === "All" ? "shares" : x.assets === "Near" ? "NEAR-side shares (NEAR and NEAR tokens)" : x.assets === "Bitcoin" ? "Bitcoin shares" : "Ethereum shares (ETH and tokens)";
    const how = x.mode === "Claim" ? "wait for a claim" : x.mode === "Automatic" ? "start automatically" : `start automatically after a ${duration(x.hybrid_grace_ms)} grace period`;
    out.push(`Except: ${who} ${what} ${how}.`);
  }
  if (o && o.delay_signers.length)
    out.push(
      `${o.delay_quorum} of ${o.delay_signers.length} delay signers can extend an approved release's waiting period by up to ${duration(o.max_extension_ms)} at a time, ${duration(o.max_total_extension_ms)} in total. They can't approve, cancel or move anything.`,
    );
  return out;
}

/** Virtual size of a P2WPKH payout with `inputs` inputs, a heir output and change. */
export const btcVsize = (inputs: number) => BigInt(Math.ceil(((10 + 41 * inputs + 43 + 31) * 4 + 2 + 108 * inputs) / 4));

/**
 * Fees for a release's Bitcoin payouts at `feeRate` sat/vB: the first spends
 * the vault's coins, each later one spends the previous change (D20).
 */
export function btcPayoutFees(opts: { heirs: number; inputs: number; feeRate: number }): bigint {
  if (opts.heirs === 0 || opts.inputs === 0) return 0n;
  return (btcVsize(opts.inputs) + BigInt(opts.heirs - 1) * btcVsize(1)) * BigInt(opts.feeRate);
}

/**
 * What a signed Sepolia transaction will most likely cost (D6 quote). The
 * contract signs with a fixed priority fee and a starting max fee, so the
 * price per gas is min(max fee, base fee + priority fee).
 */
export function ethTxCost(gasUsed: bigint, baseFee: bigint, cfg: { eth_initial_max_fee: string; eth_priority_fee: string }): bigint {
  const max = BigInt(cfg.eth_initial_max_fee);
  const prio = BigInt(cfg.eth_priority_fee) < max ? BigInt(cfg.eth_priority_fee) : max;
  const price = baseFee + prio < max ? baseFee + prio : max;
  return gasUsed * price;
}
