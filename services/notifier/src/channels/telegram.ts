// Telegram Bot API. Linking: the web app gets a one-time token for the signed-in
// account and opens t.me/<bot>?start=<token>; Telegram sends "/start <token>"
// to the bot, which binds that chat to the account. "/stop" unlinks the chat.
// A 403 (the user blocked the bot) disables the contact.
import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { telegramNotice } from "./templates.js";
import { PermanentError, RejectedError, TransientError, type Outgoing, type Sender } from "./types.js";

interface Update {
  update_id: number;
  message?: { chat: { id: number; type: string; username?: string; first_name?: string; title?: string }; text?: string };
}

/** Same cap as the API's LIMITS.telegram. */
export const MAX_CHATS = 3;

type Log = (msg: string, data?: Record<string, unknown>) => void;

export class TelegramBot implements Sender {
  private stopped = false;
  /** Called after a chat is linked (the engine tells the account's other channels). */
  onLinked?: (account: string, contactId: number, who: string) => void;
  constructor(
    private cfg: NonNullable<Config["telegram"]>,
    private store: Store,
    private log: Log = () => {},
    private fetchFn: typeof fetch = fetch,
  ) {}

  linkUrl(t: string) {
    return `https://t.me/${this.cfg.username}?start=${t}`;
  }

  async api<T>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiBase}/bot${this.cfg.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TransientError(`telegram ${method}: ${(e as Error).name === "TimeoutError" ? "timeout" : "network error"}`);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (body.ok) return body.result as T;
    const code = body.error_code ?? res.status;
    const msg = `telegram ${method} ${code}: ${body.description ?? "error"}`;
    if (code === 403) throw new PermanentError(msg); // blocked by the user, or kicked from the group
    if (code === 429) throw new TransientError(msg, (body.parameters?.retry_after ?? 5) * 1000);
    if (code === 400 && /chat not found|user is deactivated/i.test(body.description ?? "")) throw new PermanentError(msg);
    if (code >= 400 && code < 500) throw new RejectedError(msg);
    throw new TransientError(msg);
  }

  async send(m: Outgoing) {
    await this.sendText(m.contact.address, telegramNotice(m));
  }

  sendText(chatId: string, html: string) {
    return this.api("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }

  /** Handles one incoming update: /start <token>, /stop, /status. */
  async handle(u: Update) {
    const msg = u.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
    const command = (cmd ?? "").split("@")[0];
    const reply = (t: string) => this.sendText(chatId, t).catch((e) => this.log("telegram reply failed", { error: String(e) }));
    if (command === "/start") {
      const account = arg ? this.store.takeTelegramLink(arg) : null;
      if (!account) {
        await reply("This link has expired or was already used. Open Behest → Notifications and link Telegram again.");
        return;
      }
      const who = msg.chat.username ? `@${msg.chat.username}` : (msg.chat.title ?? msg.chat.first_name ?? "this chat");
      const meta = JSON.stringify({ username: msg.chat.username ?? null, name: msg.chat.title ?? msg.chat.first_name ?? null, type: msg.chat.type });
      const existing = this.store.contactBy(account, "telegram", chatId);
      if (!existing && this.store.countContacts(account, "telegram") >= MAX_CHATS) {
        await reply(`${account.replace(/[<>&]/g, "")} already has ${MAX_CHATS} Telegram chats linked. Remove one in Behest first.`);
        return;
      }
      let id: number;
      if (existing) {
        id = existing.id;
        this.store.activate(id);
        this.store.updateContact(id, { meta, label: who });
      } else {
        id = this.store.addContact({ account, channel: "telegram", address: chatId, status: "active", label: who, meta }).id;
      }
      this.log("telegram linked", { account });
      this.onLinked?.(account, id, who);
      await reply(`Linked to <b>${account.replace(/[<>&]/g, "")}</b>. Behest will send plan notices here.\nSend /stop to unlink this chat.`);
      return;
    }
    if (command === "/stop") {
      const linked = this.store.contactsByAddress("telegram", chatId);
      for (const c of linked) this.store.removeContact(c.id);
      await reply(linked.length ? "Unlinked. Behest won't message this chat again." : "This chat isn't linked to any Behest account.");
      return;
    }
    if (command === "/status") {
      const linked = this.store.contactsByAddress("telegram", chatId).filter((c) => c.status === "active");
      await reply(linked.length ? `This chat gets notices for: ${linked.map((c) => c.account).join(", ")}.\nSend /stop to unlink.` : "This chat isn't linked. Link it from Behest → Notifications.");
      return;
    }
    if (command === "/help" || msg.text.startsWith("/")) await reply("Link this chat from Behest → Notifications. Commands: /status, /stop.");
  }

  /** Long-polls getUpdates until stop(); the offset is kept in the database. */
  async poll() {
    await this.api("deleteWebhook", {}).catch(() => {});
    while (!this.stopped) {
      const offset = Number(this.store.meta("telegram_offset") ?? 0);
      try {
        const updates = await this.api<Update[]>("getUpdates", { offset, timeout: this.cfg.pollTimeoutS, allowed_updates: ["message"] }, (this.cfg.pollTimeoutS + 10) * 1000);
        for (const u of updates) {
          await this.handle(u).catch((e) => this.log("telegram update failed", { error: String(e) }));
          this.store.setMeta("telegram_offset", String(u.update_id + 1));
        }
      } catch (e) {
        this.log("telegram poll failed", { error: String(e) });
        await new Promise((r) => setTimeout(r, e instanceof TransientError && e.retryAfterMs ? e.retryAfterMs : 5000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
