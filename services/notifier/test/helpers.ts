// Test utilities: NEP-413 signing with near-api-js (an independent
// implementation of the format), an in-process SMTP sink, a fake Telegram Bot
// API, and a local webhook receiver.
import { randomBytes } from "node:crypto";
import { createServer as createHttp, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { actionMessage, type SignedEnvelope } from "../src/auth.js";

export const RECIPIENT = "behest-notifier";

export function newSigner() {
  const kp = KeyPair.fromRandom("ed25519");
  return { signer: KeyPairSigner.fromSecretKey(kp.toString() as KeyPairString), publicKey: kp.getPublicKey().toString() };
}

export async function envelope(signer: KeyPairSigner, account: string, action: string, args: Record<string, unknown> = {}, o: { ts?: number; recipient?: string; nonce?: Buffer } = {}): Promise<SignedEnvelope> {
  const message = actionMessage(action, { action, account, ts: o.ts ?? Date.now(), ...args });
  const nonce = o.nonce ?? randomBytes(32);
  const recipient = o.recipient ?? RECIPIENT;
  const r = await signer.signNep413Message(account, { message, recipient, nonce });
  return { accountId: account, publicKey: r.publicKey.toString(), signature: Buffer.from(r.signature).toString("base64"), nonce: nonce.toString("base64"), message, recipient };
}

const port = (s: Server | TcpServer) => (s.address() as AddressInfo).port;
const listen = <T extends Server | TcpServer>(s: T) => new Promise<T>((r) => s.listen(0, "127.0.0.1", () => r(s)));

export interface Mail {
  from: string;
  to: string[];
  data: string;
}

/**
 * Minimal SMTP server: enough of RFC 5321 for nodemailer. `reject` maps a
 * recipient to an SMTP reply (e.g. "550 no such user") given at RCPT TO.
 */
export async function smtpSink(reject: Record<string, string> = {}) {
  const mails: Mail[] = [];
  const server = createTcp((sock) => {
    let buf = "";
    let inData = false;
    let cur: Mail = { from: "", to: [], data: "" };
    const say = (s: string) => sock.write(`${s}\r\n`);
    say("220 sink ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          cur = { from: "", to: [], data: "" };
          say("250 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-sink\r\n250 8BITMIME\r\n");
        else if (cmd === "HELO") say("250 sink");
        else if (cmd === "MAIL") {
          cur.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0] ?? "";
          say("250 ok");
        } else if (cmd === "RCPT") {
          const to = line.slice(8).replace(/[<>]/g, "").trim();
          if (reject[to]) say(reject[to]!);
          else {
            cur.to.push(to);
            say("250 ok");
          }
        } else if (cmd === "DATA") {
          inData = true;
          say("354 go ahead");
        } else if (cmd === "RSET") {
          cur = { from: "", to: [], data: "" };
          say("250 ok");
        } else if (cmd === "QUIT") {
          say("221 bye");
          sock.end();
        } else say("250 ok");
      }
    });
    sock.on("error", () => {});
  });
  await listen(server);
  return { mails, port: port(server), close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Decodes a quoted-printable body enough to find links in test mails. */
export const unQP = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export interface Hook {
  headers: IncomingMessage["headers"];
  body: string;
}

/** Local webhook receiver; `status` decides the reply. */
export async function receiver(status: () => number = () => 200) {
  const hits: Hook[] = [];
  const server = createHttp((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ headers: req.headers, body });
      res.writeHead(status());
      res.end("ok");
    });
  });
  await listen(server);
  return { hits, url: `http://127.0.0.1:${port(server)}/hook`, port: port(server), close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface TgCall {
  method: string;
  params: Record<string, unknown>;
}

/** Fake Telegram Bot API: queue updates, see calls, mark chats as having blocked the bot. */
export async function fakeTelegram() {
  const calls: TgCall[] = [];
  const updates: unknown[] = [];
  const blocked = new Set<string>();
  let nextId = 1;
  const server = createHttp((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop() ?? "";
      const params = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      calls.push({ method, params });
      const reply = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (!(req.url ?? "").startsWith("/botTEST:TOKEN/")) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
      if (method === "getUpdates") {
        const offset = Number(params.offset ?? 0);
        const out = (updates as { update_id: number }[]).filter((u) => u.update_id >= offset);
        if (out.length) return reply(200, { ok: true, result: out });
        return setTimeout(() => reply(200, { ok: true, result: [] }), 50);
      }
      if (method === "sendMessage") {
        if (blocked.has(String(params.chat_id))) return reply(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
        return reply(200, { ok: true, result: { message_id: nextId++ } });
      }
      reply(200, { ok: true, result: true });
    });
  });
  await listen(server);
  let uid = 1;
  return {
    calls,
    blocked,
    apiBase: `http://127.0.0.1:${port(server)}`,
    push(chatId: number, text: string, username = "amara") {
      updates.push({ update_id: uid++, message: { chat: { id: chatId, type: "private", username, first_name: "Amara" }, text } });
    },
    sent: (chatId: number) => calls.filter((c) => c.method === "sendMessage" && String(c.params.chat_id) === String(chatId)).map((c) => String(c.params.text)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
