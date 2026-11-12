// D33: optional backup of sealed heirs' recovery records. The owner chooses
// it per plan. Records are checked against the plan's on-chain commitments,
// stored encrypted (AES-256-GCM, key from NOTIFY_RECORDS_KEY), handed to the
// owner at any time and to each heir (signed in) only once the plan is
// overdue. Behest can read them: this trades privacy from Behest for not
// losing a share when a record is lost. Nothing here can move funds.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export interface HeirRecord {
  account_id: string;
  share_bps: number;
  near_destination: string | null;
  eth_destination: string | null;
  btc_destination: string | null;
  salt: string;
}

export interface RecordsChain {
  /** The plan's sealed commitments, or null for a public plan. */
  commitments(owner: string): Promise<string[] | null>;
  commitmentOf(owner: string, record: HeirRecord): Promise<string>;
  /** Overdue or later: reveals are open. */
  overdue(owner: string): Promise<boolean>;
}

export function parseKey(hex: string | undefined): Buffer | null {
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("NOTIFY_RECORDS_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(hex, "hex");
}

/** Row id for a heir: a keyed hash, so the database doesn't list who the heirs are. */
export function rowId(key: Buffer, owner: string, account: string): string {
  return createHmac("sha256", key).update(`behest-record-row:${owner}:${account}`).digest("hex");
}

export function seal(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function open(key: Buffer, sealed: string, aad: string): string {
  const b = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Shape check only; the contract's commitment decides whether it's real. */
export function cleanRecord(r: unknown): HeirRecord | null {
  const x = r as Record<string, unknown>;
  const opt = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" && v.length <= 128 ? v : undefined);
  if (!x || typeof x !== "object") return null;
  const rec = {
    account_id: x.account_id,
    share_bps: x.share_bps,
    near_destination: opt(x.near_destination),
    eth_destination: opt(x.eth_destination),
    btc_destination: opt(x.btc_destination),
    salt: x.salt,
  };
  if (typeof rec.account_id !== "string" || !ACCOUNT.test(rec.account_id)) return null;
  if (typeof rec.share_bps !== "number" || !Number.isInteger(rec.share_bps) || rec.share_bps < 0 || rec.share_bps > 10_000) return null;
  if (rec.near_destination === undefined || rec.eth_destination === undefined || rec.btc_destination === undefined) return null;
  if (typeof rec.salt !== "string" || !/^[0-9a-f]{64}$/.test(rec.salt)) return null;
  return rec as HeirRecord;
}
