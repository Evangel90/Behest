// Delivery engine. A notice is fanned out once (its key is recorded in the
// same transaction) to every recipient account × every active contact of
// that account whose preferences allow the kind, plus the operator feed.
// Each (notice, account, contact) is tracked on its own: a failing webhook
// retries with exponential backoff without holding up, or repeating, the
// email that already went out. After `maxAttempts` the delivery is marked
// failed and kept for inspection. A contact that can never receive again
// (bot blocked, mailbox gone, 410) is disabled.
//
// Delivery is at-least-once: a crash between a successful send and its
// record can repeat that one message after restart. Webhook receivers can
// de-duplicate on X-Behest-Delivery.
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import type { Channel, Contact, Delivery, Store, StoredNotice } from "./db.js";
import { ALWAYS_ON, type Notice } from "./diff.js";
import { PermanentError, RejectedError, TransientError, type Outgoing, type Sender } from "./channels/types.js";
import type { WebhookSender } from "./channels/webhook.js";

export const OPERATOR = "operator";

type Log = (msg: string, data?: Record<string, unknown>) => void;

/** Token bucket: `rate` per second, bursts up to `rate`. */
export class Bucket {
  private tokens: number;
  private at: number;
  constructor(
    private rate: number,
    now = Date.now(),
  ) {
    this.tokens = rate;
    this.at = now;
  }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface Senders {
  email?: Sender;
  telegram?: Sender;
  webhook?: WebhookSender;
}

export class Engine {
  private buckets: Record<Channel, Bucket>;
  private busy = false;

  constructor(
    private store: Store,
    private cfg: Pick<Config, "maxAttempts" | "retryBaseMs" | "rate" | "publicUrl" | "appUrl" | "operatorWebhookUrl" | "operatorWebhookSecret">,
    private senders: Senders,
    private log: Log = () => {},
    private now: () => number = Date.now,
  ) {
    const t = now();
    this.buckets = { email: new Bucket(cfg.rate.email, t), telegram: new Bucket(cfg.rate.telegram, t), webhook: new Bucket(cfg.rate.webhook, t) };
  }

  /** Records a notice and queues its deliveries. Returns false if the notice was already handled. */
  fanOut(n: Notice, recipients: string[]): boolean {
    const now = this.now();
    return this.store.tx(() => {
      if (!this.store.addNotice(n, recipients, now)) return false;
      let queued = 0;
      for (const account of recipients) {
        if (!ALWAYS_ON.includes(n.kind) && !this.store.wants(account, n.kind)) continue;
        for (const c of this.store.activeContacts(account)) {
          if (this.store.enqueue({ notice_key: n.key, account, target: String(c.id), channel: c.channel }, now)) queued++;
        }
      }
      if (this.cfg.operatorWebhookUrl) this.store.enqueue({ notice_key: n.key, account: "*", target: OPERATOR, channel: "webhook" }, now);
      this.log("notice", { key: n.key, kind: n.kind, owner: n.owner, recipients, queued, text: n.text });
      return true;
    });
  }

  /** A notice to one account only (channel added, Telegram linked), skipping the contact it concerns. */
  security(account: string, subject: string, text: string, exceptContact?: number): string {
    const key = `security:${account}:${this.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const now = this.now();
    this.store.tx(() => {
      this.store.addNotice({ key, owner: account, kind: "security", to: [], accounts: [account], subject, text, links: this.cfg.appUrl ? [{ label: "Review your notification settings", url: `${this.cfg.appUrl.replace(/\/$/, "")}/notifications` }] : [] }, [account], now);
      for (const c of this.store.activeContacts(account)) {
        if (c.id !== exceptContact) this.store.enqueue({ notice_key: key, account, target: String(c.id), channel: c.channel }, now);
      }
    });
    return key;
  }

  outgoing(notice: StoredNotice, account: string, contact: Contact, test = false): Outgoing {
    return {
      notice,
      account,
      contact,
      deliveryId: createDeliveryId(notice.key, account, String(contact.id)),
      unsubscribeUrl: `${this.cfg.publicUrl}/v1/unsubscribe?token=${encodeURIComponent(contact.unsub_token)}`,
      settingsUrl: this.cfg.appUrl ? `${this.cfg.appUrl.replace(/\/$/, "")}/notifications` : this.cfg.publicUrl,
      test,
    };
  }

  backoff(attempts: number, hintMs?: number): number {
    const exp = Math.min(this.cfg.retryBaseMs * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
    const jitter = exp * (0.8 + Math.random() * 0.4);
    return Math.max(jitter, hintMs ?? 0);
  }

  private async sendOne(d: Delivery): Promise<"sent" | "retry" | "failed" | "cancelled"> {
    const notice = this.store.notice(d.notice_key);
    if (!notice) {
      this.store.cancel(d, "notice missing");
      return "cancelled";
    }
    try {
      if (d.target === OPERATOR) {
        if (!this.cfg.operatorWebhookUrl || !this.senders.webhook) {
          this.store.cancel(d, "operator feed not configured");
          return "cancelled";
        }
        const pseudo = { id: 0, account: "*", channel: "webhook", address: this.cfg.operatorWebhookUrl, secret: this.cfg.operatorWebhookSecret ?? null, unsub_token: "" } as Contact;
        await this.senders.webhook.post(this.cfg.operatorWebhookUrl, this.cfg.operatorWebhookSecret ?? null, { ...this.outgoing(notice, "*", pseudo), deliveryId: createDeliveryId(d.notice_key, "*", OPERATOR) }, true);
      } else {
        const contact = this.store.contact(Number(d.target));
        if (!contact || contact.status !== "active") {
          this.store.cancel(d, "contact removed or inactive");
          return "cancelled";
        }
        const sender = this.senders[contact.channel];
        if (!sender) throw new TransientError(`${contact.channel} is not configured on this notifier`);
        await sender.send(this.outgoing(notice, d.account, contact));
      }
      this.store.markSent(d, this.now());
      this.log("delivered", { key: d.notice_key, account: d.account, channel: d.channel, target: d.target });
      return "sent";
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (e instanceof PermanentError) {
        this.store.markFailed(d, msg);
        if (d.target !== OPERATOR) this.store.disable(Number(d.target), msg);
        this.log("contact disabled", { account: d.account, channel: d.channel, target: d.target, error: msg });
        return "failed";
      }
      if (e instanceof RejectedError || d.attempts + 1 >= this.cfg.maxAttempts) {
        this.store.markFailed(d, e instanceof RejectedError ? msg : `gave up after ${d.attempts + 1} attempts: ${msg}`);
        this.log("delivery failed", { key: d.notice_key, account: d.account, channel: d.channel, target: d.target, attempts: d.attempts + 1, error: msg });
        return "failed";
      }
      const next = this.now() + this.backoff(d.attempts + 1, e instanceof TransientError ? e.retryAfterMs : undefined);
      this.store.markRetry(d, next, msg);
      this.log("delivery retry", { key: d.notice_key, account: d.account, channel: d.channel, target: d.target, attempts: d.attempts + 1, next: new Date(next).toISOString(), error: msg });
      return "retry";
    }
  }

  /** Sends what is due, within each channel's rate. */
  async dispatch(limit = 200): Promise<Record<string, number>> {
    const counts: Record<string, number> = { sent: 0, retry: 0, failed: 0, cancelled: 0, throttled: 0 };
    if (this.busy) return counts;
    this.busy = true;
    try {
      for (const d of this.store.due(this.now(), limit)) {
        if (!this.buckets[d.channel].take(this.now())) {
          counts.throttled!++;
          continue;
        }
        counts[await this.sendOne(d)]!++;
      }
    } finally {
      this.busy = false;
    }
    return counts;
  }

  /** Test ping to one contact, outside the queue. Throws the channel's error. */
  async test(contact: Contact) {
    const notice: StoredNotice = {
      key: `test:${contact.id}:${this.now()}`,
      owner: contact.account,
      kind: "security",
      to: [],
      subject: "Test notification",
      text: `This is a test from Behest for ${contact.account}. If you can read it, this channel works.`,
      links: [],
      recipients: [contact.account],
      created_ms: this.now(),
    };
    const sender = this.senders[contact.channel];
    if (!sender) throw new TransientError(`${contact.channel} is not configured on this notifier`);
    if (!this.buckets[contact.channel].take(this.now())) throw new TransientError("busy; try again in a moment");
    await sender.send(this.outgoing(notice, contact.account, contact, true));
  }
}

export const createDeliveryId = (key: string, account: string, target: string) => createHash("sha256").update(`${key}\u0000${account}\u0000${target}`).digest("hex").slice(0, 32);
