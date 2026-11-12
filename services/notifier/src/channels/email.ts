// Email over any SMTP provider (nodemailer). Notices carry RFC 8058 one-click
// unsubscribe headers; verification mails don't (there's nothing to leave).
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";
import { emailNotice, emailVerification } from "./templates.js";
import { PermanentError, RejectedError, TransientError, type Outgoing, type Sender } from "./types.js";

export class EmailSender implements Sender {
  private t: Transporter;
  /** STARTTLS on 587 and implicit TLS on 465 for host/port configs: some networks hold up one of them. */
  private alt: Transporter | null;
  constructor(
    private cfg: NonNullable<Config["smtp"]>,
    transport?: Transporter,
  ) {
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

  private async mail(msg: { to: string; subject: string; text: string; html: string; headers?: Record<string, string> }) {
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
