import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it } from "vitest";
import { classifySmtp, EmailSender } from "../src/channels/email.js";
import { TelegramBot } from "../src/channels/telegram.js";
import { PermanentError, RejectedError, TransientError, type Outgoing } from "../src/channels/types.js";
import { checkWebhookUrl, guardedLookup, guardedPost, isPublicAddress, sign, verifyWebhook, WebhookSender } from "../src/channels/webhook.js";
import { Store, type Contact, type StoredNotice } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { fakeTelegram, receiver, smtpSink, unQP, until } from "./helpers.js";

const notice: StoredNotice = {
  key: "kemi.testnet:confirmed:1:0",
  owner: "kemi.testnet",
  kind: "transfer_confirmed",
  to: [],
  accounts: ["amara.testnet"],
  subject: "1 ETH from Kemi's plan arrived",
  text: "1 ETH from Kemi's plan arrived at 0xabc.",
  proposalId: 1,
  transferIndex: 0,
  asset: "ETH",
  amount: "1",
  txHash: "0xfeed",
  links: [{ label: "View on Etherscan (Sepolia)", url: "https://sepolia.etherscan.io/tx/0xfeed" }],
  recipients: ["amara.testnet"],
  created_ms: Date.UTC(2026, 10, 10),
};
const contact = (o: Partial<Contact>): Contact => ({ id: 7, account: "amara.testnet", channel: "email", address: "amara@example.com", label: null, secret: null, status: "active", verify_hash: null, verify_expires_ms: null, unsub_token: "UNSUB", created_ms: 0, verified_ms: 0, disabled_reason: null, meta: null, ...o });
const out = (c: Contact): Outgoing => ({ notice, account: c.account, contact: c, deliveryId: "d".repeat(32), unsubscribeUrl: "https://n.example/v1/unsubscribe?token=UNSUB", settingsUrl: "https://app.example/notifications" });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe("webhook SSRF guard", () => {
  it("knows public from private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "224.0.0.1", "64:ff9b::a00:1"]) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("checks URLs before any request", () => {
    expect(checkWebhookUrl("https://hooks.slack.com/services/T/B/x").host).toBe("hooks.slack.com");
    for (const bad of ["http://example.com/x", "https://user:pw@example.com/", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest", "https://localhost/", "https://printer.local/", "https://example.com:22/", "ftp://example.com", "nope", "https://x/" + "a".repeat(3000)]) {
      expect(() => checkWebhookUrl(bad), bad).toThrow();
    }
    expect(checkWebhookUrl("http://127.0.0.1:9999/x", true).port).toBe("9999");
  });

  it("refuses at connect time when a name resolves to a private address (no DNS rebinding window)", async () => {
    const fakeDns = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])) as never;
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => guardedLookup(false, fakeDns)("evil.example", { all: true }, (e) => r(e)));
    expect(err?.code).toBe("EPRIVATE");
    const ok = await new Promise<unknown>((r) => guardedLookup(true, fakeDns)("evil.example", {}, (_e, a) => r(a)));
    expect(ok).toBe("93.184.216.34");
    // a real request to a name that resolves to loopback is refused
    const rx = await receiver();
    closers.push(rx.close);
    await expect(guardedPost(new URL(`http://localhost:${rx.port}/hook`), "{}", {}, false)).rejects.toMatchObject({ code: "EPRIVATE" });
    expect(rx.hits).toHaveLength(0);
  });
});

describe("webhook delivery", () => {
  it("posts signed JSON with structured fields and Slack/Discord text", async () => {
    const rx = await receiver();
    closers.push(rx.close);
    const c = contact({ channel: "webhook", address: rx.url, secret: "whsec_test" });
    await new WebhookSender("behest-ekkr6.testnet", true).send(out(c));
    const [hit] = rx.hits;
    expect(hit!.headers["x-behest-event"]).toBe("transfer_confirmed");
    expect(hit!.headers["x-behest-delivery"]).toBe("d".repeat(32));
    expect(verifyWebhook("whsec_test", String(hit!.headers["x-behest-signature"]), String(hit!.headers["x-behest-timestamp"]), hit!.body)).toBe(true);
    expect(verifyWebhook("wrong", String(hit!.headers["x-behest-signature"]), String(hit!.headers["x-behest-timestamp"]), hit!.body)).toBe(false);
    expect(verifyWebhook("whsec_test", String(hit!.headers["x-behest-signature"]), String(hit!.headers["x-behest-timestamp"]), hit!.body + " ")).toBe(false);
    const body = JSON.parse(hit!.body);
    expect(body).toMatchObject({ kind: "transfer_confirmed", owner: "kemi.testnet", account: "amara.testnet", proposal_id: 1, transfer_index: 0, tx_hash: "0xfeed", explorer_url: "https://sepolia.etherscan.io/tx/0xfeed", contract_id: "behest-ekkr6.testnet" });
    expect(body.text).toContain("arrived");
    expect(body.content).toBe(body.text);
  });

  it("rejects stale signatures", () => {
    const s = sign("k", 1000, "{}");
    expect(verifyWebhook("k", s, "1000", "{}", 300, 1200)).toBe(true);
    expect(verifyWebhook("k", s, "1000", "{}", 300, 1400)).toBe(false);
  });

  it("classifies responses: 2xx ok, 410 disables, 4xx rejected, 5xx/429 retried", async () => {
    let status = 410;
    const rx = await receiver(() => status);
    closers.push(rx.close);
    const w = new WebhookSender("c", true);
    const c = contact({ channel: "webhook", address: rx.url, secret: "s" });
    await expect(w.send(out(c))).rejects.toBeInstanceOf(PermanentError);
    status = 400;
    await expect(w.send(out(c))).rejects.toBeInstanceOf(RejectedError);
    status = 503;
    await expect(w.send(out(c))).rejects.toBeInstanceOf(TransientError);
    status = 429;
    await expect(w.send(out(c))).rejects.toBeInstanceOf(TransientError);
    status = 302;
    await expect(w.send(out(c))).rejects.toBeInstanceOf(RejectedError);
    // without the development override, http:// is refused outright
    await expect(new WebhookSender("c", false).send(out(c))).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("email", () => {
  it("sends notices with one-click unsubscribe headers through SMTP", async () => {
    const sink = await smtpSink();
    closers.push(sink.close);
    const mail = new EmailSender({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTls: true, from: "Behest <notify@behest.example>" });
    await mail.send(out(contact({})));
    const [m] = sink.mails;
    expect(m!.to).toEqual(["amara@example.com"]);
    const data = unQP(m!.data);
    expect(data).toMatch(/^Subject: Behest: 1 ETH from Kemi's plan arrived/m);
    expect(data).toContain("List-Unsubscribe: <https://n.example/v1/unsubscribe?token=UNSUB>");
    expect(data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(data).toContain("https://sepolia.etherscan.io/tx/0xfeed");
    expect(data).toContain("text/html");
    expect(data).not.toMatch(/\b(died|death|deceased)\b/i);
  });

  it("sends a confirmation link and classifies SMTP failures", async () => {
    const sink = await smtpSink({ "gone@example.com": "550 5.1.1 no such user", "busy@example.com": "451 4.3.0 try later" });
    closers.push(sink.close);
    const mail = new EmailSender({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTls: true, from: "notify@behest.example" });
    await mail.sendVerification("kemi.testnet", "kemi@example.com", "https://n.example/v1/verify?token=abc", 48);
    expect(unQP(sink.mails[0]!.data)).toContain("https://n.example/v1/verify?token=abc");
    await expect(mail.send(out(contact({ address: "gone@example.com" })))).rejects.toBeInstanceOf(PermanentError);
    await expect(mail.send(out(contact({ address: "busy@example.com" })))).rejects.toBeInstanceOf(TransientError);
    expect(classifySmtp({ responseCode: 552 })).toBeInstanceOf(RejectedError);
    expect(classifySmtp({ responseCode: 535, code: "EAUTH" })).toBeInstanceOf(TransientError);
    expect(classifySmtp({ code: "ECONNREFUSED" })).toBeInstanceOf(TransientError);
  });
});

describe("telegram", () => {
  const setup = async () => {
    const tg = await fakeTelegram();
    closers.push(tg.close);
    const store = new Store();
    const bot = new TelegramBot({ token: "TEST:TOKEN", username: "behest_test_bot", apiBase: tg.apiBase, pollTimeoutS: 1 }, store);
    return { tg, store, bot };
  };

  it("links a chat with a one-time start token, and /stop unlinks it", async () => {
    const { tg, store, bot } = await setup();
    const linked: string[] = [];
    bot.onLinked = (account) => linked.push(account);
    expect(bot.linkUrl("tok")).toBe("https://t.me/behest_test_bot?start=tok");
    store.addTelegramLink("amara.testnet", "tok123", Date.now() + 60_000);
    tg.push(1001, "/start tok123");
    tg.push(2002, "/start tok123"); // a second chat using the same link gets nothing
    tg.push(1001, "/status");
    const poll = bot.poll();
    await until(() => tg.sent(1001).length >= 2 && tg.sent(2002).length >= 1);
    expect(store.activeContacts("amara.testnet").map((c) => [c.address, c.label])).toEqual([["1001", "@amara"]]);
    expect(linked).toEqual(["amara.testnet"]);
    expect(tg.sent(1001)[0]).toContain("Linked to <b>amara.testnet</b>");
    expect(tg.sent(2002)[0]).toContain("expired");
    expect(tg.sent(1001)[1]).toContain("amara.testnet");
    tg.push(1001, "/stop");
    await until(() => tg.sent(1001).length >= 3);
    expect(store.contacts("amara.testnet")).toEqual([]);
    bot.stop();
    await poll;
    expect(Number(store.meta("telegram_offset"))).toBe(5);
  });

  it("refuses expired tokens", async () => {
    const { tg, store, bot } = await setup();
    store.addTelegramLink("amara.testnet", "old", Date.now() - 1);
    await bot.handle({ update_id: 1, message: { chat: { id: 5, type: "private" }, text: "/start old" } });
    expect(tg.sent(5)[0]).toContain("expired");
    expect(store.contacts("amara.testnet")).toEqual([]);
  });

  it("disables the contact when the user blocked the bot", async () => {
    const { tg, store, bot } = await setup();
    const c = store.addContact({ account: "amara.testnet", channel: "telegram", address: "3003", status: "active" });
    const engine = new Engine(store, { maxAttempts: 5, retryBaseMs: 1000, rate: { email: 10, telegram: 10, webhook: 10 }, publicUrl: "https://n.example" }, { telegram: bot });
    engine.fanOut({ ...notice }, ["amara.testnet"]);
    await engine.dispatch();
    expect(tg.sent(3003)[0]).toContain("<b>1 ETH from Kemi's plan arrived</b>");
    tg.blocked.add("3003");
    engine.fanOut({ ...notice, key: "second" }, ["amara.testnet"]);
    await engine.dispatch();
    expect(store.contact(c.id)).toMatchObject({ status: "disabled" });
    expect(store.contact(c.id)!.disabled_reason).toContain("403");
  });
});
