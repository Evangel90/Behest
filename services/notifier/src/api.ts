// Notifier HTTP API (node:http). Contacts are private and off-chain; every
// change needs a NEP-413 signature from the account (see auth.ts). Reading
// your own settings uses a short session token obtained the same way.
//
//   GET    /healthz                       liveness + channel availability
//   GET    /v1/info                       public: channels, kinds, signing recipient, limits
//   POST   /v1/session                    signed "session" → bearer token
//   DELETE /v1/session                    bearer
//   GET    /v1/contacts                   bearer: contacts, preferences, watched plans, recent notices
//   POST   /v1/contacts                   signed "contacts.add" (email | webhook)
//   DELETE /v1/contacts/:id               signed "contacts.remove"
//   POST   /v1/contacts/:id/resend        bearer: resend an email confirmation
//   POST   /v1/contacts/:id/test          bearer: test message (any channel)
//   POST   /v1/webhooks/:id/test          same, for webhooks
//   POST   /v1/telegram/link              signed "telegram.link" → t.me deep link
//   PUT    /v1/preferences                signed "preferences.set"
//   PUT    /v1/watches                    signed "watches.set"
//   PUT    /v1/council                    signed "council.set" by a council member: the DAO's notices go to its whole council (D26)
//   PUT    /v1/records                    signed "records.set" by a sealed plan's owner: back up its heirs' recovery records (D33)
//   DELETE /v1/records                    signed "records.clear"
//   GET    /v1/records?owner=…            bearer: the owner gets all; a heir gets its own once the plan is overdue
//   GET    /v1/people                     bearer: the people this owner named with an email address
//   POST   /v1/people                     bearer: name someone by email (creates their wallets) or attach an email to an account
//   DELETE /v1/people/:account?role=…     bearer
//   GET    /v1/named                      bearer: the plans that name this account through an email
//   POST   /v1/email-wallets              public: make sure an email address has wallets before it signs in (returns nothing about them)
//   GET    /v1/verify?token=…             page with a confirm button (mail scanners don't confirm by fetching)
//   POST   /v1/verify                     confirm an email
//   GET    /v1/unsubscribe?token=…        page with an unsubscribe button
//   POST   /v1/unsubscribe?token=…        RFC 8058 one-click, or the page's form
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AuthError, verifyEnvelope, type SignedAction } from "./auth.js";
import type { Mailer } from "./channels/email.js";
import { esc } from "./channels/templates.js";
import type { TelegramBot } from "./channels/telegram.js";
import { PermanentError, RejectedError } from "./channels/types.js";
import { checkWebhookUrl, UrlError } from "./channels/webhook.js";
import type { Config } from "./config.js";
import { sha256, token, type Channel, type Contact, type Store, PERSON_ROLES, scopeOf, type Person, type PersonRole } from "./db.js";
import { ALWAYS_ON, KIND_INFO, KINDS, type Kind } from "./diff.js";
import type { CouncilOf } from "./council.js";
import type { Engine } from "./engine.js";
import type { KeyLookup } from "./nep413.js";
import { cleanRecord, open, rowId, seal, type HeirRecord, type RecordsChain } from "./records.js";
import { PrivyError, type PrivyClient } from "./privy.js";

export const LIMITS = {
  email: 3,
  telegram: 3,
  webhook: 5,
  watches: 20,
  /** Confirmation emails per address and per account, per day. */
  verifyPerAddressPerDay: 3,
  verifyPerAccountPerDay: 10,
  verifyHours: 48,
  telegramLinkMinutes: 15,
  sessionMinutes: 120,
  /** Requests per IP per minute, and signed actions per account per minute. */
  ipPerMinute: 120,
  accountPerMinute: 30,
  /** People one owner may name with an email address, and how many they may add in a day. */
  people: 40,
  peoplePerDay: 60,
  /** Unsigned "make sure this address has wallets" calls per IP per minute. */
  emailWalletsPerMinute: 6,
};

export interface ApiDeps {
  store: Store;
  engine: Engine;
  cfg: Pick<Config, "contractId" | "publicUrl" | "appUrl" | "allowedOrigins" | "signRecipient" | "signMaxAgeMs" | "trustProxy" | "webhookAllowInsecure">;
  keys: KeyLookup;
  email?: Mailer;
  telegram?: TelegramBot;
  isMember?: (owner: string, account: string) => Promise<boolean>;
  /** D26: a DAO's council members (get_policy), or null when the account isn't a DAO. */
  councilOf?: CouncilOf;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** D33 record backup: off unless a key is configured. */
  records?: { key: Buffer; chain: RecordsChain };
  /** Wallets for people named by email: off unless Privy is configured. */
  privy?: Pick<PrivyClient, "ensure">;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Sliding one-minute window counter. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute: number) {}
  take(key: string, now = Date.now()): boolean {
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (h.length >= this.perMinute) {
      this.hits.set(key, h);
      return false;
    }
    h.push(now);
    this.hits.set(key, h);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 60_000)) this.hits.delete(k);
    return true;
  }
}

const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export function normalizeEmail(s: unknown): string {
  if (typeof s !== "string") throw new HttpError(400, "BAD_EMAIL", "email is required");
  const e = s.trim();
  if (e.length > 254 || !EMAIL.test(e)) throw new HttpError(400, "BAD_EMAIL", "that doesn't look like an email address");
  // lower-cased whole: providers treat local parts case-insensitively, and per-address limits must too
  return e.toLowerCase();
}

/** What an owner asks to be called in messages: letters, digits and a little punctuation, so it can't carry a link or pose as a sender. */
function displayName(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = String(v).trim().replace(/\s+/g, " ");
  if (n.length > 40 || !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'’-]*$/u.test(n)) throw new HttpError(400, "BAD_NAME", "use a plain name of up to 40 letters");
  return n;
}

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function publicContact(c: Contact, store: Store) {
  const last = store.contactDeliveries(c.id, 1)[0];
  let meta: Record<string, unknown> | null = null;
  try {
    meta = c.meta ? (JSON.parse(c.meta) as Record<string, unknown>) : null;
  } catch {}
  return {
    id: c.id,
    channel: c.channel,
    address: c.address,
    label: c.label,
    status: c.status,
    created_ms: c.created_ms,
    verified_ms: c.verified_ms,
    disabled_reason: c.disabled_reason,
    // Owners who supplied this address (it only hears about their plans), or null for one the account set up.
    added_by: scopeOf(c),
    telegram: c.channel === "telegram" ? meta : undefined,
    last_delivery: last ? { status: last.status, at_ms: last.sent_ms ?? last.created_ms, error: last.last_error } : null,
  };
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Behest</title>
<style>body{margin:0;padding:24px 16px;background:#f5f5f5;color:#171717;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}main{max-width:480px;margin:10vh auto 0;background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:24px}h1{font-size:22px;margin:0 0 12px;font-weight:600}button{min-height:48px;padding:0 20px;border:0;border-radius:12px;background:#2F6BFF;color:#fff;font:600 15px inherit;cursor:pointer}p.small{font-size:13px;color:#737373}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#f5f5f5}main{background:#171717;border-color:#262626}}</style></head>
<body><main><p class="small">Behest</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function createApi(d: ApiDeps): Server {
  const { store, engine, cfg } = d;
  const log = d.log ?? (() => {});
  const now = d.now ?? Date.now;
  const ipLimit = new RateLimiter(LIMITS.ipPerMinute);
  const walletLimit = new RateLimiter(LIMITS.emailWalletsPerMinute);
  const accountLimit = new RateLimiter(LIMITS.accountPerMinute);
  const authDeps = { store, keys: d.keys, recipient: cfg.signRecipient, maxAgeMs: cfg.signMaxAgeMs, now };

  const clientIp = (req: IncomingMessage) => (cfg.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "?";

  function cors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || !cfg.allowedOrigins.includes(origin)) return { vary: "Origin" };
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }
  const json = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...cors(req) });
    res.end(JSON.stringify(body));
  };
  const html = (res: ServerResponse, status: number, title: string, body: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "referrer-policy": "no-referrer" });
    res.end(page(title, body));
  };

  async function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) throw new HttpError(413, "TOO_LARGE", "request body too large");
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function readJson(req: IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError(400, "BAD_REQUEST", "invalid JSON");
    }
  }
  async function signed(req: IncomingMessage, action: string): Promise<SignedAction> {
    const a = await verifyEnvelope(await readJson(req), authDeps, action);
    if (!accountLimit.take(`a:${a.account}`, now())) throw new HttpError(429, "RATE_LIMITED", "too many requests for this account; wait a minute");
    return a;
  }
  function bearer(req: IncomingMessage): string {
    const h = String(req.headers.authorization ?? "");
    const t = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const account = t ? store.session(t, now()) : null;
    if (!account) throw new HttpError(401, "NO_SESSION", "sign in to the notifier again");
    if (!accountLimit.take(`a:${account}`, now())) throw new HttpError(429, "RATE_LIMITED", "too many requests for this account; wait a minute");
    return account;
  }
  const ownContact = (account: string, id: number) => {
    const c = store.contact(id);
    if (!c || c.account !== account) throw new HttpError(404, "NOT_FOUND", "no such contact");
    return c;
  };

  async function sendVerification(c: Contact) {
    if (!d.email) throw new HttpError(503, "EMAIL_UNAVAILABLE", "email isn't configured on this notifier");
    const day = now() - 86_400_000;
    if (store.emailsSince(c.address, day) >= LIMITS.verifyPerAddressPerDay) throw new HttpError(429, "EMAIL_LIMIT", "this address got enough confirmation emails today; try tomorrow");
    if (store.emailsByAccountSince(c.account, day) >= LIMITS.verifyPerAccountPerDay) throw new HttpError(429, "EMAIL_LIMIT", "this account sent enough confirmation emails today; try tomorrow");
    const t = token();
    store.updateContact(c.id, { verify_hash: sha256(t), verify_expires_ms: now() + LIMITS.verifyHours * 3_600_000 });
    store.logEmail(c.address, c.account, now());
    try {
      await d.email.sendVerification(c.account, c.address, `${cfg.publicUrl}/v1/verify?token=${t}`, LIMITS.verifyHours);
    } catch (e) {
      log("verification email failed", { account: c.account, error: String(e) });
      if (e instanceof PermanentError || e instanceof RejectedError) throw new HttpError(400, "EMAIL_REJECTED", "the mail server refused that address");
      throw new HttpError(502, "EMAIL_FAILED", "couldn't send the confirmation email; try again shortly");
    }
  }

  /** A person as the owner who named them sees it. */
  const publicPerson = (p: Person) => {
    const c = store.contactBy(p.account, "email", p.email);
    return {
      account: p.account,
      role: p.role,
      email: p.email,
      label: p.label,
      by_email: p.by_email === 1,
      announce: p.announce === 1,
      near: p.near,
      btc: p.btc,
      told_ms: p.named_ms,
      // "unsubscribed": they asked for no more mail; nothing is sent whatever the owner does.
      email_status: !c ? "removed" : c.status === "active" ? "active" : c.disabled_reason === "unsubscribed" ? "unsubscribed" : c.status,
    };
  };
  const ensureWallets = async (email: string) => {
    if (!d.privy) throw new HttpError(503, "EMAIL_WALLETS_UNAVAILABLE", "naming people by email isn't set up on this notifier");
    try {
      return await d.privy.ensure(email);
    } catch (e) {
      log("email wallets failed", { error: String(e), status: e instanceof PrivyError ? e.status : undefined });
      throw new HttpError(502, "EMAIL_WALLETS_FAILED", "couldn't set up an account for that address; try again shortly");
    }
  };

  const channels = () => ({ email: Boolean(d.email), telegram: d.telegram ? { bot: d.telegram.linkUrl("").replace(/\?start=$/, "") } : false, webhook: true });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/$/, "") || "/";
    const m = req.method ?? "GET";
    if (m === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }
    if (!ipLimit.take(`ip:${clientIp(req)}`, now())) throw new HttpError(429, "RATE_LIMITED", "too many requests; wait a minute");

    if (m === "GET" && (path === "/healthz" || path === "/health")) return json(req, res, 200, { ok: true, contract: cfg.contractId, channels: { email: Boolean(d.email), telegram: Boolean(d.telegram), webhook: true }, deliveries: store.deliveryStats() });
    if (m === "GET" && path === "/v1/info") {
      return json(req, res, 200, {
        contract: cfg.contractId,
        recipient: cfg.signRecipient,
        max_age_ms: cfg.signMaxAgeMs,
        channels: channels(),
        kinds: KINDS.map((k) => ({ kind: k, ...KIND_INFO[k], always_on: ALWAYS_ON.includes(k) })),
        limits: { email: LIMITS.email, telegram: LIMITS.telegram, webhook: LIMITS.webhook, watches: LIMITS.watches },
        webhook_https_only: !cfg.webhookAllowInsecure,
        records: Boolean(d.records),
        email_wallets: Boolean(d.privy),
        people_roles: PERSON_ROLES,
      });
    }

    // ---- people named with an email address
    if (m === "POST" && path === "/v1/email-wallets") {
      // Before an address signs in for the first time: its wallets must exist. Says nothing about them.
      if (!walletLimit.take(clientIp(req), now())) throw new HttpError(429, "RATE_LIMITED", "too many requests; wait a minute");
      const body = (await readJson(req)) as { email?: unknown };
      await ensureWallets(normalizeEmail(body.email));
      return json(req, res, 200, { ok: true });
    }
    if (m === "GET" && path === "/v1/people") {
      const owner = bearer(req);
      return json(req, res, 200, { name: store.ownerName(owner), people: store.people(owner).map(publicPerson) });
    }
    if (m === "GET" && path === "/v1/named") {
      // For the person: which plans name this account by email, and who their owners are to them.
      return json(req, res, 200, { plans: store.namedBy(bearer(req)) });
    }
    if (m === "PUT" && path === "/v1/people/name") {
      const owner = bearer(req);
      const body = (await readJson(req)) as { name?: unknown };
      store.setOwnerName(owner, displayName(body.name));
      return json(req, res, 200, { name: store.ownerName(owner) });
    }
    if (m === "POST" && path === "/v1/people") {
      const owner = bearer(req);
      const body = (await readJson(req)) as { email?: unknown; role?: unknown; account?: unknown; announce?: unknown; label?: unknown; name?: unknown };
      const email = normalizeEmail(body.email);
      const role = body.role as PersonRole;
      if (!PERSON_ROLES.includes(role)) throw new HttpError(400, "BAD_ROLE", `role must be one of ${PERSON_ROLES.join(", ")}`);
      const day = now() - 86_400_000;
      if (store.peopleAddedSince(owner, day) >= LIMITS.peoplePerDay) throw new HttpError(429, "PEOPLE_LIMIT", "that's a lot of people for one day; try again tomorrow");
      let account: string;
      let near: string | null = null;
      let btc: string | null = null;
      const byEmail = body.account == null || body.account === "";
      if (byEmail) {
        const w = await ensureWallets(email);
        account = w.eth;
        near = w.near;
        btc = w.btc;
      } else {
        account = String(body.account).trim().toLowerCase();
        if (!ACCOUNT.test(account) && !/^0x[0-9a-f]{40}$/.test(account)) throw new HttpError(400, "BAD_ACCOUNT", "that doesn't look like an account");
      }
      if (!store.person(owner, account, role) && store.countPeople(owner) >= LIMITS.people) throw new HttpError(400, "LIMIT", `at most ${LIMITS.people} people with an email per plan`);
      if (body.name !== undefined) store.setOwnerName(owner, displayName(body.name));
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : null;
      const p = store.putPerson({ owner, account, role, email, label, by_email: byEmail ? 1 : 0, announce: body.announce === true || role !== "heir" ? 1 : 0, near, btc }, now());
      log("person named", { owner, role, by_email: byEmail });
      return json(req, res, 201, { person: publicPerson(p), name: store.ownerName(owner) });
    }
    const personPath = path.match(/^\/v1\/people\/([^/]+)$/);
    if (m === "DELETE" && personPath && personPath[1] !== "name") {
      const owner = bearer(req);
      const role = url.searchParams.get("role") ?? "";
      if (!store.removePerson(owner, decodeURIComponent(personPath[1]!).toLowerCase(), role)) throw new HttpError(404, "NOT_FOUND", "no such person");
      return json(req, res, 200, { ok: true });
    }

    // ---- sessions
    if (m === "POST" && path === "/v1/session") {
      const a = await signed(req, "session");
      const t = token(32);
      const expires_ms = now() + LIMITS.sessionMinutes * 60_000;
      store.addSession(a.account, t, expires_ms);
      return json(req, res, 200, { token: t, account: a.account, expires_ms });
    }
    if (m === "DELETE" && path === "/v1/session") {
      const h = String(req.headers.authorization ?? "");
      if (h.startsWith("Bearer ")) store.endSession(h.slice(7).trim());
      return json(req, res, 200, { ok: true });
    }

    // ---- reading your settings
    if (m === "GET" && path === "/v1/contacts") {
      const account = bearer(req);
      return json(req, res, 200, {
        account,
        contacts: store.contacts(account).map((c) => publicContact(c, store)),
        preferences: store.prefs(account),
        watches: store.watches(account),
        councils: store.councils().filter((dao) => store.council(dao)?.enabled_by === account),
        recent: store.recentNotices([account], 20).map((n) => ({ key: n.key, kind: n.kind, owner: n.owner, subject: n.subject, text: n.text, links: n.links, created_ms: n.created_ms })),
      });
    }

    // ---- adding a contact
    if (m === "POST" && path === "/v1/contacts") {
      const a = await signed(req, "contacts.add");
      const channel = a.channel as Channel;
      if (channel === "email") {
        const address = normalizeEmail(a.address);
        const existing = store.contactBy(a.account, "email", address);
        // The account is the wallet created for this very address: signing as it proves the inbox, so no confirmation email.
        if (existing && scopeOf(existing) && store.isOwnEmail(a.account, address)) {
          store.activate(existing.id, now());
          log("email confirmed", { account: a.account });
          return json(req, res, 200, { contact: publicContact(store.contact(existing.id)!, store), message: `${address} now gets every notice for this account.` });
        }
        if (!d.email) throw new HttpError(503, "EMAIL_UNAVAILABLE", "email isn't configured on this notifier");
        if (existing?.status === "active" && !scopeOf(existing)) throw new HttpError(409, "EXISTS", "that address is already confirmed");
        if (existing?.status === "active") {
          // An owner supplied this address; now the account itself asks for it. It keeps hearing about that owner's plan meanwhile.
          await sendVerification(existing);
          return json(req, res, 201, { contact: publicContact(store.contact(existing.id)!, store), message: `We sent a confirmation link to ${address}.` });
        }
        if (!existing && store.countContacts(a.account, "email") >= LIMITS.email) throw new HttpError(400, "LIMIT", `at most ${LIMITS.email} email addresses per account`);
        const c = existing ?? store.addContact({ account: a.account, channel: "email", address, status: "pending", label: typeof a.label === "string" ? a.label.slice(0, 60) : null });
        if (existing) store.updateContact(c.id, { status: "pending", disabled_reason: null });
        try {
          await sendVerification(store.contact(c.id)!);
        } catch (e) {
          if (!existing) store.removeContact(c.id);
          throw e;
        }
        log("email added", { account: a.account });
        return json(req, res, 201, { contact: publicContact(store.contact(c.id)!, store), message: `We sent a confirmation link to ${address}. Nothing is sent there until it's confirmed.` });
      }
      if (channel === "webhook") {
        let u: URL;
        try {
          u = checkWebhookUrl(String(a.url ?? ""), cfg.webhookAllowInsecure);
        } catch (e) {
          throw new HttpError(400, "BAD_URL", e instanceof UrlError ? e.message : "invalid URL");
        }
        if (store.contactBy(a.account, "webhook", u.toString())) throw new HttpError(409, "EXISTS", "that webhook is already registered");
        if (store.countContacts(a.account, "webhook") >= LIMITS.webhook) throw new HttpError(400, "LIMIT", `at most ${LIMITS.webhook} webhooks per account`);
        const secret = `whsec_${token(32)}`;
        const c = store.addContact({ account: a.account, channel: "webhook", address: u.toString(), status: "active", secret, label: typeof a.label === "string" ? a.label.slice(0, 60) : null });
        engine.security(a.account, "Webhook added", `A webhook (${u.host}) was added to the notifications for ${a.account}. If you didn't do this, remove it in Behest.`, c.id);
        log("webhook added", { account: a.account, host: u.host });
        return json(req, res, 201, { contact: publicContact(c, store), secret, message: "Save the signing secret now; it won't be shown again." });
      }
      throw new HttpError(400, "BAD_CHANNEL", "channel must be email or webhook (link Telegram with /v1/telegram/link)");
    }

    const idMatch = path.match(/^\/v1\/(contacts|webhooks)\/(\d+)(?:\/(resend|test))?$/);
    if (idMatch) {
      const id = Number(idMatch[2]);
      const sub = idMatch[3];
      if (m === "DELETE" && !sub && idMatch[1] === "contacts") {
        const a = await signed(req, "contacts.remove");
        if (Number(a.id) !== id) throw new HttpError(400, "ID_MISMATCH", "the signed request names a different contact");
        const c = ownContact(a.account, id);
        // Removing an address an owner supplied is the person saying no: it stays off even if the owner names them again.
        if (scopeOf(c)) store.disable(id, "unsubscribed");
        else store.removeContact(id);
        if (c.status === "active") engine.security(a.account, "Notification channel removed", `${c.channel === "email" ? c.address : c.channel === "telegram" ? `Telegram ${c.label ?? "chat"}` : "A webhook"} was removed from the notifications for ${a.account}.`);
        log("contact removed", { account: a.account, channel: c.channel });
        return json(req, res, 200, { ok: true });
      }
      if (m === "POST" && sub === "resend" && idMatch[1] === "contacts") {
        const account = bearer(req);
        const c = ownContact(account, id);
        if (c.channel !== "email" || c.status === "active") throw new HttpError(400, "NOT_PENDING", "only unconfirmed email addresses need a new link");
        store.updateContact(c.id, { status: "pending", disabled_reason: null });
        await sendVerification(c);
        return json(req, res, 200, { ok: true });
      }
      if (m === "POST" && sub === "test") {
        const account = bearer(req);
        const c = ownContact(account, id);
        if (idMatch[1] === "webhooks" && c.channel !== "webhook") throw new HttpError(404, "NOT_FOUND", "no such webhook");
        if (c.status !== "active") throw new HttpError(400, "NOT_ACTIVE", "confirm or re-enable this channel first");
        try {
          await engine.test(c);
        } catch (e) {
          if (e instanceof PermanentError) store.disable(c.id, (e as Error).message);
          return json(req, res, 200, { ok: false, error: (e as Error).message });
        }
        return json(req, res, 200, { ok: true });
      }
    }

    // ---- Telegram
    if (m === "POST" && path === "/v1/telegram/link") {
      const a = await signed(req, "telegram.link");
      if (!d.telegram) throw new HttpError(503, "TELEGRAM_UNAVAILABLE", "Telegram isn't configured on this notifier");
      if (store.countContacts(a.account, "telegram") >= LIMITS.telegram) throw new HttpError(400, "LIMIT", `at most ${LIMITS.telegram} Telegram chats per account`);
      const t = token(24); // 32 base64url chars: fits Telegram's 64-char start parameter
      const expires_ms = now() + LIMITS.telegramLinkMinutes * 60_000;
      store.addTelegramLink(a.account, t, expires_ms);
      return json(req, res, 200, { url: d.telegram.linkUrl(t), expires_ms });
    }

    // ---- preferences and watched plans
    if (m === "PUT" && path === "/v1/preferences") {
      const a = await signed(req, "preferences.set");
      const p = (a.preferences ?? {}) as Record<string, unknown>;
      const clean: Partial<Record<Kind, boolean>> = {};
      for (const [k, v] of Object.entries(p)) if ((KINDS as readonly string[]).includes(k) && typeof v === "boolean" && !ALWAYS_ON.includes(k as Kind)) clean[k as Kind] = v;
      store.setPrefs(a.account, clean);
      return json(req, res, 200, { preferences: store.prefs(a.account) });
    }
    if (m === "PUT" && path === "/v1/watches") {
      const a = await signed(req, "watches.set");
      const owners = Array.isArray(a.owners) ? [...new Set(a.owners.filter((o): o is string => typeof o === "string" && ACCOUNT.test(o)))] : null;
      if (!owners) throw new HttpError(400, "BAD_REQUEST", "owners must be a list of account ids");
      if (owners.length > LIMITS.watches) throw new HttpError(400, "LIMIT", `at most ${LIMITS.watches} plans`);
      const kept: string[] = [];
      const refused: string[] = [];
      for (const o of owners) {
        // only plans the account has a role in; the account's own plan is always watched
        if (o === a.account || !d.isMember || (await d.isMember(o, a.account).catch(() => false))) kept.push(o);
        else refused.push(o);
      }
      store.setWatches(a.account, kept);
      return json(req, res, 200, { watches: kept, refused });
    }

    if (m === "PUT" && path === "/v1/council") {
      const a = await signed(req, "council.set");
      const dao = typeof a.dao === "string" ? a.dao : "";
      if (!ACCOUNT.test(dao)) throw new HttpError(400, "BAD_REQUEST", "dao must be an account id");
      if (typeof a.enabled !== "boolean") throw new HttpError(400, "BAD_REQUEST", "enabled must be true or false");
      if (!d.councilOf) throw new HttpError(503, "COUNCIL_UNAVAILABLE", "this notifier can't read DAO councils");
      const members = await d.councilOf(dao).catch(() => {
        throw new HttpError(502, "RPC", "couldn't read the DAO's policy; try again");
      });
      if (!members) throw new HttpError(400, "NOT_A_DAO", `${dao} isn't a DAO (it has no get_policy)`);
      if (!members.includes(a.account)) throw new HttpError(403, "NOT_COUNCIL", `${a.account} isn't on ${dao}'s council`);
      store.setCouncil(dao, a.account, a.enabled, now());
      return json(req, res, 200, { dao, enabled: a.enabled, members });
    }

    // ---- D33 recovery record backups
    if (path === "/v1/records") {
      const r = d.records;
      if (!r) throw new HttpError(503, "RECORDS_UNAVAILABLE", "record backup isn't enabled on this notifier");
      const aad = (owner: string, account: string) => `behest-record:${cfg.contractId}:${owner}:${account}`;
      if (m === "PUT") {
        const a = await signed(req, "records.set");
        const list = Array.isArray(a.records) ? a.records.map(cleanRecord) : null;
        if (!list || !list.length || list.length > 10 || list.some((x) => !x)) throw new HttpError(400, "BAD_REQUEST", "records must be 1–10 heir records");
        const recs = list as HeirRecord[];
        if (new Set(recs.map((x) => x.account_id)).size !== recs.length) throw new HttpError(400, "BAD_REQUEST", "one record per heir");
        const sealedOn = await r.chain.commitments(a.account).catch(() => {
          throw new HttpError(502, "RPC", "couldn't read the plan; try again");
        });
        if (!sealedOn) throw new HttpError(400, "NOT_SEALED", "this plan doesn't keep its heirs private");
        for (const rec of recs) {
          const c = await r.chain.commitmentOf(a.account, rec);
          if (!sealedOn.includes(c)) throw new HttpError(400, "NO_MATCH", `the record for ${rec.account_id} doesn't match the plan`);
        }
        store.setRecords(a.account, recs.map((rec) => { const id = rowId(r.key, a.account, rec.account_id); return { account: id, sealed: seal(r.key, JSON.stringify(rec), aad(a.account, id)) }; }), now());
        engine.security(a.account, "Heir records backed up", `Behest now keeps an encrypted copy of ${recs.length} recovery record${recs.length === 1 ? "" : "s"} for your plan. Each heir can get theirs once you're overdue. If you didn't do this, remove the backup in Behest.`);
        return json(req, res, 200, { owner: a.account, accounts: recs.map((x) => x.account_id) });
      }
      if (m === "DELETE") {
        const a = await signed(req, "records.clear");
        store.setRecords(a.account, [], now());
        return json(req, res, 200, { owner: a.account, accounts: [] });
      }
      if (m === "GET") {
        const account = bearer(req);
        const owner = url.searchParams.get("owner") ?? "";
        if (!ACCOUNT.test(owner)) throw new HttpError(400, "BAD_REQUEST", "owner must be an account id");
        const read = (row: { account: string; sealed: string; created_ms: number }) => ({ ...(JSON.parse(open(r.key, row.sealed, aad(owner, row.account))) as HeirRecord), backed_up_ms: row.created_ms });
        if (account === owner) return json(req, res, 200, { owner, records: store.records(owner).map(read).sort((x, y) => x.account_id.localeCompare(y.account_id)) });
        const row = store.record(owner, rowId(r.key, owner, account));
        if (!row) throw new HttpError(404, "NOT_FOUND", "Behest doesn't keep a record for you on this plan");
        if (!(await r.chain.overdue(owner).catch(() => false))) throw new HttpError(403, "NOT_YET", "your record is released once the owner is overdue");
        log("record released", { owner, account });
        return json(req, res, 200, { owner, records: [read(row)] });
      }
    }

    // ---- email confirmation and unsubscribe (opened from emails)
    if (path === "/v1/verify") {
      if (m === "GET") {
        const t = url.searchParams.get("token") ?? "";
        const c = t ? store.contactByVerify(sha256(t)) : undefined;
        if (!c || (c.verify_expires_ms ?? 0) < now()) return html(res, 400, "This link has expired", "<p>Add the address again in Behest to get a new link.</p>");
        return html(res, 200, "Confirm your email", `<p>Send Behest plan notifications for <b>${esc(c.account)}</b> to ${esc(c.address)}?</p><form method="post" action="/v1/verify"><input type="hidden" name="token" value="${esc(t)}"><button type="submit">Confirm</button></form>`);
      }
      if (m === "POST") {
        const form = new URLSearchParams(await readBody(req, 4096));
        const t = form.get("token") ?? url.searchParams.get("token") ?? "";
        const c = t ? store.contactByVerify(sha256(t)) : undefined;
        if (!c || (c.verify_expires_ms ?? 0) < now()) return html(res, 400, "This link has expired", "<p>Add the address again in Behest to get a new link.</p>");
        store.activate(c.id, now());
        engine.security(c.account, "Email added", `${c.address} now receives the notifications for ${c.account}. If you didn't do this, remove it in Behest.`, c.id);
        log("email confirmed", { account: c.account });
        return html(res, 200, "Email confirmed", `<p>${esc(c.address)} will get notices for <b>${esc(c.account)}</b>. Every email has a link to unsubscribe.</p>${cfg.appUrl ? `<p><a href="${esc(cfg.appUrl.replace(/\/$/, ""))}/notifications">Back to Behest</a></p>` : ""}`);
      }
    }
    if (path === "/v1/unsubscribe") {
      const t = url.searchParams.get("token") ?? "";
      const c = t ? store.contactByUnsub(t) : undefined;
      if (m === "GET") {
        if (!c) return html(res, 404, "Already unsubscribed", "<p>This address no longer gets Behest notices.</p>");
        return html(res, 200, "Unsubscribe", `<p>Stop sending Behest notices for <b>${esc(c.account)}</b> to ${esc(c.channel === "email" ? c.address : c.label ?? c.channel)}?</p><form method="post" action="/v1/unsubscribe?token=${esc(encodeURIComponent(t))}"><button type="submit">Unsubscribe</button></form>`);
      }
      if (m === "POST") {
        await readBody(req, 4096).catch(() => ""); // RFC 8058 body "List-Unsubscribe=One-Click", or the form
        if (c) {
          // An address an owner supplied is kept, switched off: naming the person again must not start the mail again.
          if (scopeOf(c)) store.disable(c.id, "unsubscribed");
          else store.removeContact(c.id);
          log("unsubscribed", { account: c.account, channel: c.channel });
        }
        return html(res, 200, "Unsubscribed", "<p>This address won't get Behest notices any more. You can add it again from Behest at any time.</p>");
      }
    }

    throw new HttpError(404, "NOT_FOUND", "no such endpoint");
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(req, res, e.status, { code: e.code, error: e.message });
      if (e instanceof AuthError) return json(req, res, e.code === "RPC_UNAVAILABLE" ? 503 : 401, { code: e.code, error: e.message });
      log("api error", { error: String(e) });
      json(req, res, 500, { code: "INTERNAL", error: "something went wrong" });
    });
  });
}
