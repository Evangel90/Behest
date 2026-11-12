// D33 sealed (private) heirs: recovery records, commitments (computed here,
// never sent to an RPC node), record files, and this browser's copy.
import { CONTRACT_ID } from "./config";
import type { PlanInput } from "./types";

export interface HeirRecord {
  account_id: string;
  share_bps: number;
  near_destination: string | null;
  eth_destination: string | null;
  btc_destination: string | null;
  /** 64 hex chars. */
  salt: string;
}

export type Unrevealed = "Redistribute" | "Fallback";

export interface SealedHeirs {
  commitments: string[];
  reveal_window_ms: number;
  unrevealed: Unrevealed;
}

export interface RevealedHeir extends Omit<HeirRecord, "salt"> {
  index: number;
  revealed_at_ms: number;
}

export interface PrivateView extends SealedHeirs {
  revealed: RevealedHeir[];
  reveal_opens_at_ms: number;
  reveal_deadline_ms: number;
}

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export function newSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Must match contracts/behest/src/privacy.rs `commitment_text`. */
export function commitmentText(owner: string, r: HeirRecord, contract = CONTRACT_ID): string {
  return ["behest-heir-v1", contract, owner, r.account_id, String(r.share_bps), r.near_destination ?? "", r.eth_destination ?? "", r.btc_destination ?? "", r.salt].join("\n");
}

export async function commitment(owner: string, r: HeirRecord, contract = CONTRACT_ID): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(commitmentText(owner, r, contract))));
}

/** Records for a draft plan's heirs (fresh salts), canonicalized like the contract. */
export function recordsFor(plan: PlanInput, btc: Record<string, string>): HeirRecord[] {
  return plan.heirs.map((h) => ({
    account_id: h.account_id,
    share_bps: h.share_bps,
    near_destination: h.near_destination,
    eth_destination: h.eth_destination ? h.eth_destination.toLowerCase() : null,
    btc_destination: btc[h.account_id]?.trim() || null,
    salt: newSalt(),
  }));
}

// ---- record files ("Download recovery record")

export interface RecordFile {
  behest_record: 1;
  contract: string;
  owner: string;
  record: HeirRecord;
}

export const recordFile = (owner: string, record: HeirRecord, contract = CONTRACT_ID): RecordFile => ({ behest_record: 1, contract, owner, record });

/** Reads a pasted or uploaded record file (or a bare record). Null if it isn't one. */
export function parseRecordFile(text: string): { owner: string | null; contract: string | null; record: HeirRecord } | null {
  try {
    const j = JSON.parse(text.trim()) as Partial<RecordFile> & Partial<HeirRecord>;
    const r = (j.record ?? j) as HeirRecord;
    if (typeof r.account_id !== "string" || typeof r.share_bps !== "number" || typeof r.salt !== "string" || !/^[0-9a-f]{64}$/.test(r.salt)) return null;
    return {
      owner: typeof j.owner === "string" ? j.owner : null,
      contract: typeof j.contract === "string" ? j.contract : null,
      record: { account_id: r.account_id, share_bps: r.share_bps, near_destination: r.near_destination ?? null, eth_destination: r.eth_destination ?? null, btc_destination: r.btc_destination ?? null, salt: r.salt },
    };
  } catch {
    return null;
  }
}

export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- this browser's copy (the owner's device)

const LOCAL = (owner: string) => `behest.records.${CONTRACT_ID}.${owner}`;

export function localRecords(owner: string): HeirRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL(owner)) ?? "[]") as HeirRecord[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveLocalRecords(owner: string, records: HeirRecord[]) {
  try {
    if (records.length) localStorage.setItem(LOCAL(owner), JSON.stringify(records));
    else localStorage.removeItem(LOCAL(owner));
  } catch {}
}

/** Keeps only records matching the plan's commitments. */
export async function matching(owner: string, records: HeirRecord[], commitments: string[]): Promise<HeirRecord[]> {
  const out: HeirRecord[] = [];
  for (const r of records) if (commitments.includes(await commitment(owner, r))) out.push(r);
  return out;
}
