// Pure plan logic for the UI: plain-language summaries, roles, what each person
// can do right now, and display formatting. No I/O, so it's unit-tested.
import type { PlanInput, PlanStatus, PlanView, Transfer, TransferState, Asset, Erc20Token } from "./types";

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
export function relative(target: number, now: number): string {
  const d = target - now;
  const abs = Math.abs(d);
  const s = abs < MIN ? `${Math.max(1, Math.round(abs / 1000))} s` : abs < HOUR ? `${Math.round(abs / MIN)} min` : abs < DAY ? `${Math.round(abs / HOUR)} h` : `${Math.round(abs / DAY)} days`;
  return d >= 0 ? `in ${s}` : `${s} ago`;
}

export function shortName(account: string): string {
  const first = account.split(".")[0] ?? account;
  // persona accounts look like "x7f2-amara.demo…": show "Amara"
  const role = first.includes("-") ? first.slice(first.lastIndexOf("-") + 1) : first;
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
  const heirs = listNames(p.heirs.map((h) => shortName(h.account_id)));
  const grace = p.grace_ms > 0 ? ` plus ${duration(p.grace_ms)} of grace` : "";
  return [
    `If ${you ? "you don't" : `${ownerLabel} doesn't`} check in for ${duration(p.check_in_interval_ms)}${grace}, any ${p.quorum} of ${p.guardians.length} guardians may propose a release.`,
    `A waiting period of ${duration(p.waiting_period_ms)} follows, during which ${you ? "you" : ownerLabel} can cancel.`,
    `Then ${heirs} receive${p.heirs.length === 1 ? "s" : ""} their shares at the fixed addresses below. Nobody can change where funds go.`,
  ].join(" ");
}

export function rolesOf(view: PlanView | null, account: string | null): Role[] {
  if (!view || !account) return [];
  const r: Role[] = [];
  if (view.plan.owner === account) r.push("owner");
  if (view.plan.policy.guardians.includes(account)) r.push("guardian");
  if (view.plan.policy.heirs.some((h) => h.account_id === account)) r.push("heir");
  return r;
}

export interface Actions {
  can: string[];
  cant: string[];
}

/** "Can act now / Can't" rows for a status card. */
export function actionsFor(view: PlanView, role: Role | "public", account?: string): Actions {
  const s = view.status;
  const p = view.plan.proposal;
  const voted = !!account && !!p && (p.approvals.includes(account) || p.rejections.includes(account));
  switch (role) {
    case "owner":
      if (s === "Active" || s === "Overdue") return { can: ["Check in", "Edit the plan", "Add or withdraw NEAR"], cant: ["Guardians can't propose while you're current"].slice(s === "Active" ? 0 : 1) };
      if (s === "Proposed" || s === "Waiting") return { can: ["Cancel the release", "Check in (also cancels)"], cant: ["Edit the plan or withdraw while a release is open"] };
      return { can: [], cant: ["Cancel: the waiting period is over", "Change recipients or amounts"] };
    case "guardian":
      if (s === "Active") return { can: [], cant: ["Propose a release while the owner is checking in"] };
      if (s === "Overdue") return { can: ["Propose a release"], cant: ["Choose recipients or amounts"] };
      if (s === "Proposed") return voted ? { can: [], cant: ["Vote twice on the same proposal"] } : { can: ["Approve or reject this exact proposal"], cant: ["Change what it pays out"] };
      return { can: [], cant: ["Stop the release: only the owner can, until the waiting period ends"] };
    case "heir":
      if (s === "Eligible" || s === "Executing") return { can: ["Receive your share"], cant: ["Change the destination"] };
      if (s === "Settled") return { can: ["See your receipts"], cant: [] };
      return { can: [], cant: ["Receive anything yet"] };
    default:
      return { can: ["Read the rules and every transfer"], cant: ["Change anything"] };
  }
}

export const LIFECYCLE: PlanStatus[] = ["Active", "Overdue", "Proposed", "Waiting", "Eligible", "Executing", "Settled"];

export const STATUS_STYLE: Record<PlanStatus, { color: string; sym: string; label: string }> = {
  Active: { color: "var(--color-s-active)", sym: "●", label: "Active" },
  Overdue: { color: "var(--color-s-overdue)", sym: "◷", label: "Owner unreachable" },
  Proposed: { color: "var(--color-s-proposed)", sym: "◆", label: "Release proposed" },
  Waiting: { color: "var(--color-s-waiting)", sym: "⧗", label: "Waiting period" },
  Eligible: { color: "var(--color-s-eligible)", sym: "◎", label: "Ready to receive" },
  Executing: { color: "var(--color-s-signing)", sym: "✎", label: "Sending" },
  Settled: { color: "var(--color-s-active)", sym: "✓", label: "Complete" },
};

export const TRANSFER_STYLE: Record<TransferState, { color: string; sym: string; label: string }> = {
  Pending: { color: "var(--color-s-cancelled)", sym: "○", label: "Not started" },
  Sending: { color: "var(--color-s-signing)", sym: "✎", label: "Sending" },
  Signing: { color: "var(--color-s-signing)", sym: "✎", label: "Signing" },
  Signed: { color: "var(--color-s-approved)", sym: "▲", label: "Signed" },
  Broadcast: { color: "var(--color-s-broadcast)", sym: "⇢", label: "On its way" },
  Confirmed: { color: "var(--color-s-active)", sym: "✓", label: "Received" },
  Failed: { color: "var(--color-s-failed)", sym: "!", label: "Needs a retry" },
};

/** Why a transfer failed, in words an heir can act on. Funds never leave the vault on failure. */
export function failureText(t: Transfer): string {
  switch (t.failure) {
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
export const registerTokens = (tokens: Erc20Token[]) => void (TOKENS = tokens);
export const tokenOf = (asset: Asset) => (typeof asset === "object" ? TOKENS.find((t) => t.address === asset.Erc20.toLowerCase()) : undefined);
export const isEvm = (asset: Asset) => asset !== "Near";
export function assetLabel(asset: Asset): string {
  if (asset === "Near") return "NEAR";
  if (asset === "Eth") return "ETH";
  return tokenOf(asset)?.symbol ?? `token ${asset.Erc20.slice(0, 8)}…`;
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
