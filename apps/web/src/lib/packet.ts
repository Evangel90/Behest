// Heir recovery packet (vision §9): everything a heir needs to find and claim
// their share years from now, without Behest's website if need be. Built
// from public contract state only; it never contains a key or a secret.
import { duration, formatAmount, modeFor, percent, shortName, type AssetGroup } from "./plan";
import type { BtcDestination, PlanInput, Recipient, ReleaseOptions, ReleaseRules } from "./types";

export const PACKET_VERSION = 1;

export interface PacketSource {
  contract: string;
  owner: string;
  version: number;
  policy: PlanInput;
  rules: ReleaseRules | null;
  options: ReleaseOptions | null;
  btcDestinations: BtcDestination[];
  ethVault: string | null;
  btcVault: string | null;
  appUrl: string;
  generatedAt: number;
}

export interface PacketMode {
  group: AssetGroup;
  mode: ReleaseOptions["mode"];
  grace_ms: number;
  /** What the heir does for this group, in words. */
  text: string;
}

export interface PacketHeir {
  account_id: string;
  share_bps: number;
  share: string;
  destinations: { near: string | null; ethereum: string | null; bitcoin: string | null };
  fixed: string[];
  alternate: Recipient | null;
  fallback: Recipient | null;
  modes: PacketMode[];
  mustClaim: boolean;
}

export interface Packet {
  packet_version: number;
  network: "testnet" | "mainnet";
  contract: string;
  owner: string;
  plan_version: number;
  app_url: string;
  plan_url: string;
  vaults: { ethereum: string | null; bitcoin: string | null };
  timers: {
    check_in_interval_ms: number;
    grace_ms: number;
    waiting_period_ms: number;
    claim_window_ms: number | null;
    hybrid_grace_ms: number | null;
  };
  guardians: { accounts: string[]; quorum: number };
  delay_signers: { accounts: string[]; quorum: number; max_extension_ms: number; max_total_extension_ms: number } | null;
  heirs: PacketHeir[];
  generated_at: string;
}

export const networkOf = (contract: string): "testnet" | "mainnet" => (contract.endsWith(".testnet") ? "testnet" : "mainnet");

function modeText(m: ReleaseOptions["mode"], grace: number): string {
  if (m === "Claim") return "You claim it yourself once the waiting period ends. Nothing moves until you do.";
  if (m === "Automatic") return "It is sent to you automatically when the waiting period ends. You don't need to do anything.";
  return `You can claim it during the ${duration(grace)} after the waiting period ends; after that it is sent to you automatically.`;
}

/** Packet for every heir, or only `heir` when given (unknown heir → none). */
export function buildPacket(src: PacketSource, heir?: string | null): Packet {
  const p = src.policy;
  const rules = src.rules;
  const o = src.options;
  const groups: AssetGroup[] = ["Near", "Ethereum", "Bitcoin"];
  const heirs = p.heirs
    .filter((h) => !heir || h.account_id === heir)
    .map((h): PacketHeir => {
      const btc = src.btcDestinations.find((d) => d.account_id === h.account_id)?.address ?? null;
      const has: Record<AssetGroup, boolean> = { Near: !!h.near_destination, Ethereum: !!h.eth_destination, Bitcoin: !!btc };
      const modes = groups
        .filter((g) => has[g])
        .map((g) => {
          const m = modeFor(o, h.account_id, g);
          return { group: g, mode: m.mode, grace_ms: m.grace_ms, text: modeText(m.mode, m.grace_ms) };
        });
      return {
        account_id: h.account_id,
        share_bps: h.share_bps,
        share: percent(h.share_bps),
        destinations: { near: h.near_destination, ethereum: h.eth_destination, bitcoin: btc },
        fixed: (rules?.fixed ?? []).filter((f) => f.heir === h.account_id).map((f) => formatAmount({ asset: f.asset, amount: f.amount })),
        alternate: rules?.alternates.find((a) => a.heir === h.account_id)?.recipient ?? null,
        fallback: rules?.fallback ?? null,
        modes,
        mustClaim: modes.some((m) => m.mode !== "Automatic"),
      };
    });
  const app = src.appUrl.replace(/\/$/, "");
  return {
    packet_version: PACKET_VERSION,
    network: networkOf(src.contract),
    contract: src.contract,
    owner: src.owner,
    plan_version: src.version,
    app_url: app,
    plan_url: `${app}/plan/${encodeURIComponent(src.owner)}`,
    vaults: { ethereum: src.ethVault, bitcoin: src.btcVault },
    timers: {
      check_in_interval_ms: p.check_in_interval_ms,
      grace_ms: p.grace_ms,
      waiting_period_ms: p.waiting_period_ms,
      claim_window_ms: rules ? rules.claim_window_ms : null,
      hybrid_grace_ms: o && o.mode === "Hybrid" ? o.hybrid_grace_ms : null,
    },
    guardians: { accounts: p.guardians, quorum: p.quorum },
    delay_signers: o && o.delay_signers.length ? { accounts: o.delay_signers, quorum: o.delay_quorum, max_extension_ms: o.max_extension_ms, max_total_extension_ms: o.max_total_extension_ms } : null,
    heirs,
    generated_at: new Date(src.generatedAt).toISOString(),
  };
}

/** The release timeline in words, owner named. */
export function timelineWords(pk: Packet): string[] {
  const t = pk.timers;
  const who = shortName(pk.owner);
  const g = pk.guardians;
  const out = [
    `${who} checks in with Behest at least every ${duration(t.check_in_interval_ms)}. A check-in is a signed message only ${who} can send.`,
    t.grace_ms > 0
      ? `If ${who} misses a check-in, a further ${duration(t.grace_ms)} of grace follows. After that the plan is overdue.`
      : `If ${who} misses a check-in, the plan is overdue straight away.`,
    `Once it is overdue, a guardian (or a heir) can propose a release. It needs ${g.quorum} of the ${g.accounts.length} guardians to approve.`,
    `After approval comes a waiting period of ${duration(t.waiting_period_ms)}. ${who} can still cancel during it, simply by checking in.`,
  ];
  if (pk.delay_signers)
    out.push(
      `${pk.delay_signers.quorum} of ${pk.delay_signers.accounts.length} delay signers can lengthen that waiting period by up to ${duration(pk.delay_signers.max_extension_ms)} at a time (${duration(pk.delay_signers.max_total_extension_ms)} at most in total). They cannot approve, cancel or redirect anything.`,
    );
  out.push("When the waiting period ends, each heir's share can move, to the addresses written in the plan and nowhere else.");
  if (t.claim_window_ms != null) out.push(`A share nobody claims within ${duration(t.claim_window_ms)} can be passed on to the named alternate or fallback.`);
  return out;
}

/** near-cli-rs commands to read the plan and claim without Behest's website. */
export function cliCommands(pk: Packet, heir: string): { label: string; cmd: string }[] {
  const net = pk.network;
  const args = `'{"owner":"${pk.owner}"}'`;
  return [
    { label: "Read the plan (anyone, no account needed)", cmd: `near contract call-function as-read-only ${pk.contract} get_plan json-args ${args} network-config ${net} now` },
    { label: "See the release and its transfers", cmd: `near contract call-function as-read-only ${pk.contract} get_release_snapshot json-args ${args} network-config ${net} now` },
    {
      label: "Claim your share (signed by your heir account)",
      cmd: `near contract call-function as-transaction ${pk.contract} claim json-args ${args} prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as ${heir} network-config ${net} sign-with-keychain send`,
    },
    {
      label: "If a transfer failed, retry it (index from the plan's transfers)",
      cmd: `near contract call-function as-transaction ${pk.contract} retry_transfer json-args '{"owner":"${pk.owner}","index":0}' prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as ${heir} network-config ${net} sign-with-keychain send`,
    },
  ];
}

export const isEthImplicit = (account: string) => /^0x[0-9a-f]{40}$/.test(account);
