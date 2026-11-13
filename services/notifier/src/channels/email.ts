// Email over any SMTP provider (nodemailer), or over Brevo's HTTPS API for
// hosts that block SMTP ports. Notices carry RFC 8058 one-click unsubscribe
// headers; verification mails don't (there's nothing to leave).
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";
import { emailNotice, emailVerification } from "./templates.js";
import { PermanentError, RejectedError, TransientError, type Outgoing, type Sender } from "./types.js";

interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

/** What the API and the engine need from email, whichever way it travels. */
export interface Mailer extends Sender {
  sendVerification(account: string, address: string, url: string, hours: number): Promise<void>;
}

abstract class TemplatedMailer implements Mailer {
  protected abstract mail(msg: Message): Promise<void>;

  async send(m: Outgoing) {
    const { subject, text, html } = emailNotice(m);
    await this.mail({
      to: m.contact.address,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${m.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Behest-Delivery": m.deliveryId,
        "X-Behest-Kind": m.notice.kind,
      },
    });
  }

  async sendVerification(account: string, address: string, url: string, hours: number) {
    const { subject, text, html } = emailVerification(account, address, url, hours);
    await this.mail({ to: address, subject, text, html });
  }
}

export class EmailSender extends TemplatedMailer {
  private t: Transporter;
  /** STARTTLS on 587 and implicit TLS on 465 for host/port configs: some networks hold up one of them. */
  private alt: Transporter | null;
  constructor(
    private cfg: NonNullable<Config["smtp"]>,
    transport?: Transporter,
  ) {
    super();
    // Generous timeouts: some providers (Gmail on slow links) take >15 s to greet.
    const make = (port: number | undefined, secure: boolean | undefined) =>
      nodemailer.createTransport({
        host: cfg.host,
        port,
        secure,
        ignoreTLS: cfg.ignoreTls,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
        connectionTimeout: 30_000,
        greetingTimeout: 45_000,
        socketTimeout: 60_000,
      });
    this.t = transport ?? (cfg.url ? nodemailer.createTransport(cfg.url) : make(cfg.port, cfg.secure));
    this.alt = transport || cfg.url || cfg.ignoreTls ? null : cfg.port === 587 ? make(465, true) : cfg.port === 465 ? make(587, false) : null;
  }

  protected async mail(msg: Message) {
    try {
      await this.t.sendMail({ from: this.cfg.from, ...msg });
    } catch (e) {
      // A connection that never got going (timeout, refused) is retried once on the other port.
      const code = (e as { code?: string }).code;
      if (!this.alt || !["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED"].includes(code ?? "")) throw classifySmtp(e);
      try {
        await this.alt.sendMail({ from: this.cfg.from, ...msg });
        [this.t, this.alt] = [this.alt, this.t];
      } catch (e2) {
        throw classifySmtp(e2);
      }
    }
  }
}

/** 550/551/553: the mailbox doesn't exist or refuses us for good. Other 5xx: this message. 4xx and network: later. */
export function classifySmtp(e: unknown): Error {
  const err = e as { responseCode?: number; message?: string; code?: string };
  const code = err.responseCode ?? 0;
  const msg = `smtp ${code || err.code || "error"}: ${err.message ?? String(e)}`;
  if (code === 550 || code === 551 || code === 553) return new PermanentError(msg);
  if (code >= 500 && err.code !== "EAUTH") return new RejectedError(msg);
  return new TransientError(msg);
}

/** "Name <a@b.c>" or a bare address, as Brevo's `sender` object. */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(from);
  if (!m) return { email: from.trim() };
  return m[1] ? { email: m[2]!, name: m[1] } : { email: m[2]! };
}

/**
 * Brevo's transactional email API (POST /smtp/email) over HTTPS. Brevo accepts
 * only non-standard custom headers and adds its own List-Unsubscribe, so only
 * the X- headers go along; the unsubscribe link is in every notice's body.
 */
export class BrevoSender extends TemplatedMailer {
  private sender: { email: string; name?: string };
  constructor(
    private cfg: NonNullable<Config["brevo"]>,
    private fetchFn: typeof fetch = fetch,
  ) {
    super();
    this.sender = parseFrom(cfg.from);
  }

  protected async mail(msg: Message) {
    const headers = Object.fromEntries(Object.entries(msg.headers ?? {}).filter(([k]) => k.startsWith("X-")));
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiBase}/smtp/email`, {
        method: "POST",
        headers: { "api-key": this.cfg.key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: this.sender,
          to: [{ email: msg.to }],
          subject: msg.subject,
          htmlContent: msg.html,
          textContent: msg.text,
          ...(Object.keys(headers).length ? { headers } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new TransientError(`brevo: ${(e as Error).message ?? String(e)}`);
    }
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw classifyBrevo(res.status, body, res.headers.get("retry-after") ?? res.headers.get("x-sib-ratelimit-reset"));
  }
}

/**
 * 400 about this message (bad address, bad content): rejected, the contact stays.
 * Everything else is ours or Brevo's to fix (key, unknown IP, sender not set up,
 * credits, rate, outage): later.
 */
export function classifyBrevo(status: number, body: { code?: string; message?: string }, retryAfter?: string | null): Error {
  const msg = `brevo ${status}${body.code ? ` ${body.code}` : ""}: ${body.message ?? "error"}`;
  const ours = ["unauthorized", "not_enough_credits", "account_under_validation", "permission_denied"].includes(body.code ?? "") || /\bsender\b/i.test(body.message ?? "");
  if (status === 400 && !ours) return new RejectedError(msg);
  const s = Number(retryAfter);
  return new TransientError(msg, retryAfter && Number.isFinite(s) && s > 0 ? Math.min(s, 3600) * 1000 : undefined);
}
