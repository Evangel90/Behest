// Durable notifier state in SQLite (node:sqlite, no native dependency).
// Holds plan snapshots, every notice ever produced (its key is the
// idempotency key), per-recipient delivery records, and the private contact
// registry. Nothing here is ever written on-chain, and nothing on-chain
// depends on it: losing this file loses contacts and history, never funds.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { KINDS, type Kind, type Notice, type Snapshot } from "./diff.js";

export type Channel = "email" | "telegram" | "webhook";
export type ContactStatus = "pending" | "active" | "disabled";

export interface Contact {
  id: number;
  account: string;
  channel: Channel;
  /** Email address, Telegram chat id, or webhook URL. */
  address: string;
  label: string | null;
  /** Webhook signing secret. */
  secret: string | null;
  status: ContactStatus;
  verify_hash: string | null;
  verify_expires_ms: number | null;
  unsub_token: string;
  created_ms: number;
  verified_ms: number | null;
  disabled_reason: string | null;
  meta: string | null;
}

export interface Delivery {
  notice_key: string;
  account: string;
  /** Contact id, or "operator" for the operator feed. */
  target: string;
  channel: Channel;
  status: "pending" | "sent" | "failed" | "cancelled";
  attempts: number;
  next_ms: number;
  last_error: string | null;
  sent_ms: number | null;
  created_ms: number;
}

export interface StoredNotice extends Notice {
  recipients: string[];
  created_ms: number;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans (owner TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notices (key TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  secret TEXT,
  status TEXT NOT NULL,
  verify_hash TEXT,
  verify_expires_ms INTEGER,
  unsub_token TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  verified_ms INTEGER,
  disabled_reason TEXT,
  meta TEXT,
  UNIQUE (account, channel, address)
);
CREATE INDEX IF NOT EXISTS contacts_account ON contacts (account);
CREATE INDEX IF NOT EXISTS contacts_verify ON contacts (verify_hash);
CREATE INDEX IF NOT EXISTS contacts_unsub ON contacts (unsub_token);
CREATE TABLE IF NOT EXISTS prefs (account TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (account, kind));
CREATE TABLE IF NOT EXISTS watches (account TEXT NOT NULL, owner TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY (account, owner));
CREATE TABLE IF NOT EXISTS deliveries (
  notice_key TEXT NOT NULL,
  account TEXT NOT NULL,
  target TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_ms INTEGER NOT NULL,
  last_error TEXT,
  sent_ms INTEGER,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (notice_key, account, target)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_ms);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, expires_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_links (token_hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS email_log (address TEXT NOT NULL, account TEXT NOT NULL, at_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS email_log_address ON email_log (address, at_ms);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  private get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  private run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }

  // ---- meta
  meta(k: string): string | undefined {
    return this.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v;
  }
  setMeta(k: string, v: string) {
    this.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** One-time import of the MVP's JSON state file (snapshots and sent keys). */
  importLegacy(path: string): number {
    if (!existsSync(path) || this.meta("legacy_imported")) return 0;
    const s = JSON.parse(readFileSync(path, "utf8")) as { sent?: string[]; last?: Record<string, Snapshot["view"]> };
    const now = Date.now();
    this.tx(() => {
      for (const [owner, view] of Object.entries(s.last ?? {})) this.putSnapshot(owner, { view }, now);
      for (const key of s.sent ?? []) this.run("INSERT OR IGNORE INTO notices (key, owner, kind, body, created_ms) VALUES (?, ?, 'legacy', '{}', ?)", key, key.split(":")[0] ?? "", now);
      this.setMeta("legacy_imported", String(now));
    });
    renameSync(path, `${path}.imported`);
    return (s.sent ?? []).length;
  }

  // ---- plan snapshots
  snapshot(owner: string): Snapshot | null {
    const r = this.get<{ snapshot: string }>("SELECT snapshot FROM plans WHERE owner = ?", owner);
    return r ? (JSON.parse(r.snapshot) as Snapshot) : null;
  }
  putSnapshot(owner: string, s: Snapshot, now = Date.now()) {
    this.run("INSERT INTO plans (owner, snapshot, updated_ms) VALUES (?, ?, ?) ON CONFLICT (owner) DO UPDATE SET snapshot = excluded.snapshot, updated_ms = excluded.updated_ms", owner, JSON.stringify(s), now);
  }
  dropSnapshot(owner: string) {
    this.run("DELETE FROM plans WHERE owner = ?", owner);
  }
  knownOwners(): string[] {
    return this.all<{ owner: string }>("SELECT owner FROM plans").map((r) => r.owner);
  }

  // ---- notices
  hasNotice(key: string): boolean {
    return !!this.get("SELECT 1 FROM notices WHERE key = ?", key);
  }
  /** Records a notice; false if its key was already handled (never fan out twice). */
  addNotice(n: Notice, recipients: string[], now = Date.now()): boolean {
    const r = this.run("INSERT OR IGNORE INTO notices (key, owner, kind, body, created_ms) VALUES (?, ?, ?, ?, ?)", n.key, n.owner, n.kind, JSON.stringify({ ...n, recipients }), now);
    return Number(r.changes) > 0;
  }
  notice(key: string): StoredNotice | null {
    const r = this.get<{ body: string; created_ms: number }>("SELECT body, created_ms FROM notices WHERE key = ?", key);
    return r ? { ...(JSON.parse(r.body) as StoredNotice), created_ms: r.created_ms } : null;
  }
  recentNotices(accounts: string[], limit = 20): StoredNotice[] {
    if (!accounts.length) return [];
    const rows = this.all<{ body: string; created_ms: number }>(
      `SELECT DISTINCT n.body, n.created_ms FROM notices n JOIN deliveries d ON d.notice_key = n.key WHERE d.account IN (${accounts.map(() => "?").join(",")}) ORDER BY n.created_ms DESC LIMIT ${Math.min(limit, 100)}`,
      ...accounts,
    );
    return rows.map((r) => ({ ...(JSON.parse(r.body) as StoredNotice), created_ms: r.created_ms }));
  }

  // ---- contacts
  contacts(account: string): Contact[] {
    return this.all<Contact>("SELECT * FROM contacts WHERE account = ? ORDER BY id", account);
  }
  contact(id: number): Contact | undefined {
    return this.get<Contact>("SELECT * FROM contacts WHERE id = ?", id);
  }
  contactBy(account: string, channel: Channel, address: string): Contact | undefined {
    return this.get<Contact>("SELECT * FROM contacts WHERE account = ? AND channel = ? AND address = ?", account, channel, address);
  }
  contactByVerify(hash: string): Contact | undefined {
    return this.get<Contact>("SELECT * FROM contacts WHERE verify_hash = ?", hash);
  }
  contactByUnsub(t: string): Contact | undefined {
    return this.get<Contact>("SELECT * FROM contacts WHERE unsub_token = ?", t);
  }
  contactsByAddress(channel: Channel, address: string): Contact[] {
    return this.all<Contact>("SELECT * FROM contacts WHERE channel = ? AND address = ?", channel, address);
  }
  activeContacts(account: string): Contact[] {
    return this.all<Contact>("SELECT * FROM contacts WHERE account = ? AND status = 'active' ORDER BY id", account);
  }
  countContacts(account: string, channel: Channel): number {
    return Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE account = ? AND channel = ?", account, channel)?.n ?? 0);
  }
  addContact(c: Pick<Contact, "account" | "channel" | "address" | "status"> & Partial<Pick<Contact, "label" | "secret" | "verify_hash" | "verify_expires_ms" | "meta">>, now = Date.now()): Contact {
    const r = this.run(
      "INSERT INTO contacts (account, channel, address, label, secret, status, verify_hash, verify_expires_ms, unsub_token, created_ms, verified_ms, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      c.account,
      c.channel,
      c.address,
      c.label ?? null,
      c.secret ?? null,
      c.status,
      c.verify_hash ?? null,
      c.verify_expires_ms ?? null,
      token(),
      now,
      c.status === "active" ? now : null,
      c.meta ?? null,
    );
    return this.contact(Number(r.lastInsertRowid))!;
  }
  updateContact(id: number, f: Partial<Pick<Contact, "status" | "verify_hash" | "verify_expires_ms" | "verified_ms" | "disabled_reason" | "label" | "meta">>) {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    this.run(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => (f[k] ?? null) as string | number | null), id);
  }
  activate(id: number, now = Date.now()) {
    this.updateContact(id, { status: "active", verify_hash: null, verify_expires_ms: null, verified_ms: now, disabled_reason: null });
  }
  disable(id: number, reason: string) {
    this.tx(() => {
      this.updateContact(id, { status: "disabled", disabled_reason: reason });
      this.run("UPDATE deliveries SET status = 'cancelled', last_error = ? WHERE target = ? AND status = 'pending'", `contact disabled: ${reason}`, String(id));
    });
  }
  removeContact(id: number) {
    this.tx(() => {
      this.run("UPDATE deliveries SET status = 'cancelled', last_error = 'contact removed' WHERE target = ? AND status = 'pending'", String(id));
      this.run("DELETE FROM contacts WHERE id = ?", id);
    });
  }
  /** Unverified email contacts whose link expired are dropped. */
  pruneContacts(now = Date.now()) {
    this.run("DELETE FROM contacts WHERE status = 'pending' AND verify_expires_ms IS NOT NULL AND verify_expires_ms < ?", now - 7 * 86_400_000);
  }
  /** Accounts with at least one active contact (their own plans are watched). */
  subscribedAccounts(): string[] {
    return this.all<{ account: string }>("SELECT DISTINCT account FROM contacts WHERE status = 'active'").map((r) => r.account);
  }

  // ---- preferences: every kind is on unless switched off
  prefs(account: string): Record<Kind, boolean> {
    const off = new Map(this.all<{ kind: string; enabled: number }>("SELECT kind, enabled FROM prefs WHERE account = ?", account).map((r) => [r.kind, r.enabled === 1]));
    return Object.fromEntries(KINDS.map((k) => [k, off.get(k) ?? true])) as Record<Kind, boolean>;
  }
  wants(account: string, kind: string): boolean {
    return this.get<{ enabled: number }>("SELECT enabled FROM prefs WHERE account = ? AND kind = ?", account, kind)?.enabled !== 0;
  }
  setPrefs(account: string, p: Partial<Record<Kind, boolean>>) {
    this.tx(() => {
      for (const [k, on] of Object.entries(p)) {
        if (!(KINDS as readonly string[]).includes(k)) continue;
        this.run("INSERT INTO prefs (account, kind, enabled) VALUES (?, ?, ?) ON CONFLICT (account, kind) DO UPDATE SET enabled = excluded.enabled", account, k, on ? 1 : 0);
      }
    });
  }

  // ---- watched plans (guardians, heirs and delay signers ask for plans before a release opens)
  watches(account: string): string[] {
    return this.all<{ owner: string }>("SELECT owner FROM watches WHERE account = ? ORDER BY created_ms", account).map((r) => r.owner);
  }
  setWatches(account: string, owners: string[], now = Date.now()) {
    this.tx(() => {
      this.run("DELETE FROM watches WHERE account = ?", account);
      for (const o of owners) this.run("INSERT OR IGNORE INTO watches (account, owner, created_ms) VALUES (?, ?, ?)", account, o, now);
    });
  }
  /** Owners some subscribed account asked to watch. */
  watchedOwners(): { account: string; owner: string }[] {
    return this.all("SELECT w.account, w.owner FROM watches w WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.account = w.account AND c.status = 'active')");
  }

  // ---- deliveries
  enqueue(d: { notice_key: string; account: string; target: string; channel: Channel }, now = Date.now()): boolean {
    const r = this.run("INSERT OR IGNORE INTO deliveries (notice_key, account, target, channel, status, attempts, next_ms, created_ms) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)", d.notice_key, d.account, d.target, d.channel, now, now);
    return Number(r.changes) > 0;
  }
  due(now = Date.now(), limit = 100): Delivery[] {
    return this.all<Delivery>("SELECT * FROM deliveries WHERE status = 'pending' AND next_ms <= ? ORDER BY next_ms LIMIT ?", now, limit);
  }
  delivery(notice_key: string, account: string, target: string): Delivery | undefined {
    return this.get<Delivery>("SELECT * FROM deliveries WHERE notice_key = ? AND account = ? AND target = ?", notice_key, account, target);
  }
  deliveries(notice_key: string): Delivery[] {
    return this.all<Delivery>("SELECT * FROM deliveries WHERE notice_key = ? ORDER BY account, target", notice_key);
  }
  markSent(d: Delivery, now = Date.now()) {
    this.run("UPDATE deliveries SET status = 'sent', attempts = attempts + 1, sent_ms = ?, last_error = NULL WHERE notice_key = ? AND account = ? AND target = ? AND status = 'pending'", now, d.notice_key, d.account, d.target);
  }
  markRetry(d: Delivery, next_ms: number, error: string) {
    this.run("UPDATE deliveries SET attempts = attempts + 1, next_ms = ?, last_error = ? WHERE notice_key = ? AND account = ? AND target = ? AND status = 'pending'", next_ms, error.slice(0, 500), d.notice_key, d.account, d.target);
  }
  markFailed(d: Delivery, error: string) {
    this.run("UPDATE deliveries SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE notice_key = ? AND account = ? AND target = ? AND status = 'pending'", error.slice(0, 500), d.notice_key, d.account, d.target);
  }
  cancel(d: Delivery, reason: string) {
    this.run("UPDATE deliveries SET status = 'cancelled', last_error = ? WHERE notice_key = ? AND account = ? AND target = ? AND status = 'pending'", reason, d.notice_key, d.account, d.target);
  }
  /** Defer without counting an attempt (rate limit, channel not configured yet). */
  defer(d: Delivery, next_ms: number) {
    this.run("UPDATE deliveries SET next_ms = ? WHERE notice_key = ? AND account = ? AND target = ? AND status = 'pending'", next_ms, d.notice_key, d.account, d.target);
  }
  deliveryStats(): Record<string, number> {
    return Object.fromEntries(this.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status").map((r) => [r.status, Number(r.n)]));
  }
  contactDeliveries(id: number, limit = 5): Delivery[] {
    return this.all<Delivery>("SELECT * FROM deliveries WHERE target = ? ORDER BY created_ms DESC LIMIT ?", String(id), limit);
  }

  // ---- replay protection, link tokens, sessions
  /** Records a signed-request nonce; false if it was used before. */
  useNonce(nonce: string, account: string, expires_ms: number): boolean {
    const r = this.run("INSERT OR IGNORE INTO nonces (nonce, account, expires_ms) VALUES (?, ?, ?)", nonce, account, expires_ms);
    return Number(r.changes) > 0;
  }
  addTelegramLink(account: string, t: string, expires_ms: number) {
    this.run("DELETE FROM tg_links WHERE account = ?", account); // one live link per account
    this.run("INSERT INTO tg_links (token_hash, account, expires_ms) VALUES (?, ?, ?)", sha256(t), account, expires_ms);
  }
  /** Single use: the token is deleted whether or not it was still valid. */
  takeTelegramLink(t: string, now = Date.now()): string | null {
    const h = sha256(t);
    const r = this.get<{ account: string; expires_ms: number }>("SELECT account, expires_ms FROM tg_links WHERE token_hash = ?", h);
    this.run("DELETE FROM tg_links WHERE token_hash = ?", h);
    return r && r.expires_ms > now ? r.account : null;
  }
  addSession(account: string, t: string, expires_ms: number) {
    this.run("INSERT INTO sessions (token_hash, account, expires_ms) VALUES (?, ?, ?)", sha256(t), account, expires_ms);
  }
  session(t: string, now = Date.now()): string | null {
    const r = this.get<{ account: string; expires_ms: number }>("SELECT account, expires_ms FROM sessions WHERE token_hash = ?", sha256(t));
    return r && r.expires_ms > now ? r.account : null;
  }
  endSession(t: string) {
    this.run("DELETE FROM sessions WHERE token_hash = ?", sha256(t));
  }
  logEmail(address: string, account: string, now = Date.now()) {
    this.run("INSERT INTO email_log (address, account, at_ms) VALUES (?, ?, ?)", address, account, now);
  }
  emailsSince(address: string, since_ms: number): number {
    return Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_log WHERE address = ? AND at_ms >= ?", address, since_ms)?.n ?? 0);
  }
  emailsByAccountSince(account: string, since_ms: number): number {
    return Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_log WHERE account = ? AND at_ms >= ?", account, since_ms)?.n ?? 0);
  }
  prune(now = Date.now()) {
    this.run("DELETE FROM nonces WHERE expires_ms < ?", now);
    this.run("DELETE FROM tg_links WHERE expires_ms < ?", now);
    this.run("DELETE FROM sessions WHERE expires_ms < ?", now);
    this.run("DELETE FROM email_log WHERE at_ms < ?", now - 7 * 86_400_000);
    this.pruneContacts(now);
  }
}

