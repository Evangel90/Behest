// D25: plan tiers paid once, upfront, in USDC. The contract is the authority
// (get_tier_config, get_tier, required_tier); this mirrors its rules so the
// setup wizard can say which tier a draft needs before anything is signed.
import { useCallback, useEffect, useState } from "react";
import { CONTRACT_ID } from "./config";
import { isTransient, view } from "./contract";
import type { Session } from "./session";
import type { PlanInput, ReleaseOptions, ReleaseRules } from "./types";

export interface TierSpec {
  name: string;
  price: string;
  max_heirs: number;
  max_guardians: number;
  external_assets: boolean;
  release_rules: boolean;
  advanced_release: boolean;
  /** D26: check-in delegates. Absent or null on a schedule saved before D26: follows release_rules. */
  checkin_delegates?: boolean | null;
}

export const delegatesAllowed = (s: TierSpec) => s.checkin_delegates ?? s.release_rules;

export interface TierConfig {
  fee_token: string | null;
  fee_symbol: string;
  fee_decimals: number;
  tiers: TierSpec[];
}

export interface Features {
  heirs: number;
  guardians: number;
  external_assets: boolean;
  release_rules: boolean;
  advanced_release: boolean;
  /** D26 */
  checkin_delegates?: boolean;
  /** D27: gated with the other cross-chain delivery features (external_assets). */
  intents_delivery?: boolean;
}

export interface TierView {
  tier: number;
  tier_name: string;
  paid: string;
  required: number;
  allowance: number;
  due: string[];
  enabled: boolean;
  features: Features | null;
}

export interface TreasuryView {
  fee_token: string | null;
  collected: string;
  withdrawn: string;
  pending: string;
  balance: string;
  payments: number;
}

/** What each tier unlocks, in the words the app uses everywhere. */
export function tierPerks(s: TierSpec): string[] {
  const out = [`${s.max_heirs === 1 ? "1 heir" : `Up to ${s.max_heirs} heirs`}`, `Up to ${s.max_guardians} guardians`];
  out.push(s.external_assets ? "NEAR, tokens, ETH and Bitcoin; heirs can receive through NEAR Intents" : "NEAR only");
  if (s.release_rules) out.push("Fixed amounts, alternates and a fallback");
  if (delegatesAllowed(s)) out.push("Check-in delegates (for DAOs and busy owners)");
  if (s.advanced_release) out.push("Automatic or hybrid release, per-heir modes, delay signers");
  else out.push("Heirs claim their share");
  return out;
}

export function features(plan: Pick<PlanInput, "heirs" | "guardians">, rules: ReleaseRules | null, options: ReleaseOptions | null, btcDestinations: number, tokenEscrow: boolean, delegates = 0, intents = false): Features {
  return {
    heirs: plan.heirs.length,
    guardians: plan.guardians.length,
    external_assets: tokenEscrow || btcDestinations > 0 || plan.heirs.some((h) => !!h.eth_destination),
    release_rules: !!rules,
    advanced_release: !!options && (options.mode !== "Claim" || options.delay_signers.length > 0 || (options.overrides ?? []).length > 0),
    checkin_delegates: delegates > 0,
    intents_delivery: intents,
  };
}

export function allows(s: TierSpec, f: Features): boolean {
  return (
    f.heirs <= s.max_heirs &&
    f.guardians <= s.max_guardians &&
    (s.external_assets || !f.external_assets) &&
    (s.release_rules || !f.release_rules) &&
    (s.advanced_release || !f.advanced_release) &&
    (delegatesAllowed(s) || !f.checkin_delegates) &&
    (s.external_assets || !f.intents_delivery)
  );
}

/** Cheapest tier allowing `f` (the contract's `tiers::required`). */
export function requiredTier(cfg: TierConfig, f: Features): number {
  const i = cfg.tiers.findIndex((s) => allows(s, f));
  return i < 0 ? cfg.tiers.length - 1 : i;
}

/** Why `f` needs more than tier `t`: the first limit it goes past. */
export function reasonFor(cfg: TierConfig, t: number, f: Features): string | null {
  const s = cfg.tiers[t];
  if (!s) return null;
  if (f.heirs > s.max_heirs) return `${f.heirs} heirs (${s.name} allows ${s.max_heirs})`;
  if (f.guardians > s.max_guardians) return `${f.guardians} guardians (${s.name} allows ${s.max_guardians})`;
  if (f.external_assets && !s.external_assets) return "Ethereum, Bitcoin or token assets";
  if (f.release_rules && !s.release_rules) return "release rules";
  if (f.advanced_release && !s.advanced_release) return "automatic or hybrid release, per-heir modes or delay signers";
  if (f.checkin_delegates && !delegatesAllowed(s)) return "check-in delegates";
  if (f.intents_delivery && !s.external_assets) return "delivery through NEAR Intents";
  return null;
}

export function formatUsd(amount: string | bigint, decimals = 6): string {
  const v = Number(BigInt(amount)) / 10 ** decimals;
  if (v === 0) return "Free";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export const formatFee = (cfg: TierConfig, amount: string | bigint) => {
  const v = Number(BigInt(amount)) / 10 ** cfg.fee_decimals;
  return `${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 6 })} ${cfg.fee_symbol}`;
};

export const paymentMsg = (owner: string) => JSON.stringify({ pay_tier: owner });

/** A first payment for an owner must be at least one whole token (the contract refunds less). */
export function payable(cfg: TierConfig, due: bigint, paid: bigint): bigint {
  const one = 10n ** BigInt(cfg.fee_decimals);
  return paid === 0n && due > 0n && due < one ? one : due;
}

let cfgCache: { at: number; p: Promise<TierConfig> } | null = null;
export function getTierConfig(): Promise<TierConfig> {
  if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.p;
  const p = view<TierConfig>("get_tier_config");
  cfgCache = { at: Date.now(), p };
  p.catch(() => {
    if (cfgCache?.p === p) cfgCache = null;
  });
  return p;
}

export const getTier = (owner: string) => view<TierView>("get_tier", { owner });
export const getTreasury = () => view<TreasuryView>("get_treasury");

export async function feeBalance(cfg: TierConfig, account: string): Promise<bigint> {
  if (!cfg.fee_token) return 0n;
  try {
    return BigInt(await view<string>("ft_balance_of", { account_id: account }, cfg.fee_token));
  } catch (e) {
    if (isTransient(e)) throw e;
    return 0n;
  }
}

/** The mock USDC on testnet has a public faucet; Circle's USDC on mainnet doesn't. */
export const isTestnet = CONTRACT_ID.endsWith(".testnet");

/** Pays `amount` of the fee token toward `owner`'s tier from the signed-in NEAR account. */
export function payFromWallet(session: Session, cfg: TierConfig, owner: string, amount: bigint) {
  if (!cfg.fee_token) throw new Error("Tiers aren't switched on for this contract.");
  return session.call("ft_transfer_call", { receiver_id: CONTRACT_ID, amount: amount.toString(), msg: paymentMsg(owner) }, { receiverId: cfg.fee_token, deposit: 1n, tgas: 80 });
}

/** Testnet: mints test USDC from the mock token's faucet (≤ 500 per call) to `to`. */
export async function mintTest(session: Session, cfg: TierConfig, to: string, amount: bigint) {
  if (!cfg.fee_token || !isTestnet) throw new Error("Test USDC exists only on testnet.");
  // D26: acting as a DAO, the member mints to the DAO directly (anyone may; no proposal needed for a faucet).
  const signer = session.dao?.member ?? session;
  for (let left = amount; left > 0n; ) {
    const n = left > 500_000_000n ? 500_000_000n : left;
    await signer.call("mint", { account_id: to, amount: n.toString() }, { receiverId: cfg.fee_token, tgas: 30 });
    left -= n;
  }
}

/** Testnet: asks the server's demo funder to mint test USDC and pay `owner`'s tier (for owners without NEAR). */
export async function payByFaucet(owner: string, tier: number): Promise<{ tier: number; amount: string }> {
  const res = await fetch("/api/demo/usdc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, tier }) });
  const body = (await res.json().catch(() => ({}))) as { tier?: number; amount?: string; error?: string };
  if (!res.ok || body.tier === undefined) throw new Error(body.error ?? "The test faucet couldn't pay this time.");
  return { tier: body.tier, amount: body.amount ?? "0" };
}

export function useTierConfig() {
  const [cfg, setCfg] = useState<TierConfig | null>(null);
  useEffect(() => {
    let live = true;
    getTierConfig().then((c) => live && setCfg(c), () => {});
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

export function useTier(owner: string | null | undefined) {
  const [tier, setTier] = useState<TierView | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    if (!owner) return;
    try {
      setTier(await getTier(owner));
      setError(false);
    } catch {
      setError(true);
    }
  }, [owner]);
  useEffect(() => {
    setTier(null);
    void reload();
  }, [reload]);
  return { tier, error, reload };
}
