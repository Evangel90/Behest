import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { EmailSender } from "../src/channels/email.js";
import { TelegramBot } from "../src/channels/telegram.js";
import { verifyWebhook, WebhookSender } from "../src/channels/webhook.js";
import { Store } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { envelope, fakeTelegram, newSigner, receiver, smtpSink, unQP } from "./helpers.js";

const ORIGIN = "http://localhost:3000";
let base = "";
let store: Store;
let engine: Engine;
let sink: Awaited<ReturnType<typeof smtpSink>>;
let tg: Awaited<ReturnType<typeof fakeTelegram>>;
let rx: Awaited<ReturnType<typeof receiver>>;
let close: () => void;
const kemi = newSigner();
const amara = newSigner();
const KEYS: Record<string, string[]> = { "kemi.testnet": [kemi.publicKey], "amara.testnet": [amara.publicKey] };

beforeAll(async () => {
  sink = await smtpSink();
  tg = await fakeTelegram();
  rx = await receiver();
  store = new Store();
  const email = new EmailSender({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTls: true, from: "notify@behest.example" });
  const telegram = new TelegramBot({ token: "TEST:TOKEN", username: "behest_test_bot", apiBase: tg.apiBase, pollTimeoutS: 1 }, store);
  const webhook = new WebhookSender("behest-ekkr6.testnet", true);
  engine = new Engine(store, { maxAttempts: 5, retryBaseMs: 1000, rate: { email: 50, telegram: 50, webhook: 50 }, publicUrl: "http://notify.test", appUrl: "http://localhost:3000" }, { email, telegram, webhook });
  const server = createApi({
    store,
    engine,
    cfg: { contractId: "behest-ekkr6.testnet", publicUrl: "http://notify.test", appUrl: "http://localhost:3000", allowedOrigins: [ORIGIN], signRecipient: "behest-notifier", signMaxAgeMs: 300_000, trustProxy: false, webhookAllowInsecure: true },
    keys: async (a) => KEYS[a] ?? null,
    email,
    telegram,
    isMember: async (owner, account) => owner === "kemi.testnet" && account === "amara.testnet",
    councilOf: async (dao) => (dao === "family.sputnikv2.testnet" ? ["kemi.testnet", "dayo.testnet"] : dao === "rpc.sputnikv2.testnet" ? Promise.reject(new Error("down")) : null),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => {
  close();
  await Promise.all([sink.close(), tg.close(), rx.close()]);
});

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
};
const sign = (who: "kemi" | "amara", action: string, args: Record<string, unknown> = {}) => envelope((who === "kemi" ? kemi : amara).signer, `${who}.testnet`, action, args);
async function session(who: "kemi" | "amara") {
  const r = await call("POST", "/v1/session", await sign(who, "session"));
  expect(r.status).toBe(200);
  return { authorization: `Bearer ${r.json.token}` };
}

describe("notifier API", () => {
  it("serves health and public info, with CORS only for the web app's origin", async () => {
    const h = await call("GET", "/healthz");
    expect(h.json).toMatchObject({ ok: true, channels: { email: true, telegram: true, webhook: true } });
    expect(h.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const info = await call("GET", "/v1/info");
    expect(info.json.recipient).toBe("behest-notifier");
    expect(info.json.channels.telegram.bot).toBe("https://t.me/behest_test_bot");
    expect(info.json.kinds.find((k: { kind: string }) => k.kind === "security").always_on).toBe(true);
    const other = await call("GET", "/healthz", undefined, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires a signature to change anything and a session to read", async () => {
    expect((await call("GET", "/v1/contacts")).status).toBe(401);
    expect((await call("POST", "/v1/contacts", { channel: "email", address: "x@y.z" })).json.code).toBe("UNSIGNED");
    const env = await sign("kemi", "session");
    expect((await call("POST", "/v1/session", env)).status).toBe(200);
    expect((await call("POST", "/v1/session", env)).json.code).toBe("REPLAY");
    // a signature for a different action can't be used here
    expect((await call("POST", "/v1/contacts", await sign("kemi", "session"))).json.code).toBe("WRONG_ACTION");
  });

  it("adds an email with double opt-in, then unsubscribes in one click", async () => {
    const auth = await session("kemi");
    const add = await call("POST", "/v1/contacts", await sign("kemi", "contacts.add", { channel: "email", address: "Kemi@Example.COM" }));
    expect(add.status).toBe(201);
    expect(add.json.contact).toMatchObject({ channel: "email", address: "kemi@example.com", status: "pending" });
    const link = unQP(sink.mails.at(-1)!.data).match(/http:\/\/notify\.test\/v1\/verify\?token=[\w-]+/)![0];
    const token = new URL(link).searchParams.get("token")!;
    // a link scanner's GET only shows the button
    const page = await call("GET", `/v1/verify?token=${token}`);
    expect(page.text).toContain("<form method=\"post\"");
    expect(store.contacts("kemi.testnet")[0]!.status).toBe("pending");
    const done = await fetch(`${base}/v1/verify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${token}` });
    expect(await done.text()).toContain("Email confirmed");
    const list = await call("GET", "/v1/contacts", undefined, auth);
    expect(list.json.contacts[0]).toMatchObject({ status: "active", address: "kemi@example.com" });
    // the link is single use
    expect((await call("GET", `/v1/verify?token=${token}`)).status).toBe(400);
    // re-adding a confirmed address is refused
    expect((await call("POST", "/v1/contacts", await sign("kemi", "contacts.add", { channel: "email", address: "kemi@example.com" }))).status).toBe(409);
    // RFC 8058 one-click unsubscribe
    const unsub = store.contacts("kemi.testnet")[0]!.unsub_token;
    const r = await fetch(`${base}/v1/unsubscribe?token=${unsub}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(r.status).toBe(200);
    expect(store.contacts("kemi.testnet")).toEqual([]);
  });

  it("limits confirmation emails per address (no email bombing)", async () => {
    const before = sink.mails.length;
    const target = "victim@example.com";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const add = await call("POST", "/v1/contacts", await sign("amara", "contacts.add", { channel: "email", address: target }));
      codes.push(add.status);
      const c = store.contactBy("amara.testnet", "email", target);
      if (c) store.removeContact(c.id); // add, remove, add again…
    }
    expect(codes).toEqual([201, 201, 201, 429]);
    expect(sink.mails.length - before).toBe(3);
  });

  it("registers a webhook, shows the secret once, signs test pings, and refuses unsafe URLs", async () => {
    const auth = await session("kemi");
    const add = await call("POST", "/v1/contacts", await sign("kemi", "contacts.add", { channel: "webhook", url: rx.url, label: "ops" }));
    expect(add.status).toBe(201);
    const secret = add.json.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const list = await call("GET", "/v1/contacts", undefined, auth);
    expect(JSON.stringify(list.json)).not.toContain(secret);
    const id = add.json.contact.id;
    const t = await call("POST", `/v1/webhooks/${id}/test`, undefined, auth);
    expect(t.json).toEqual({ ok: true });
    const hit = rx.hits.at(-1)!;
    expect(JSON.parse(hit.body)).toMatchObject({ test: true, account: "kemi.testnet" });
    expect(verifyWebhook(secret, String(hit.headers["x-behest-signature"]), String(hit.headers["x-behest-timestamp"]), hit.body)).toBe(true);
    // amara can't test or remove kemi's webhook
    expect((await call("POST", `/v1/webhooks/${id}/test`, undefined, await session("amara"))).status).toBe(404);
    expect((await call("DELETE", `/v1/contacts/${id}`, await sign("amara", "contacts.remove", { id }))).status).toBe(404);
    // the signed id must match the path
    expect((await call("DELETE", `/v1/contacts/${id}`, await sign("kemi", "contacts.remove", { id: id + 1 }))).json.code).toBe("ID_MISMATCH");
    expect((await call("DELETE", `/v1/contacts/${id}`, await sign("kemi", "contacts.remove", { id }))).status).toBe(200);
    expect(store.contacts("kemi.testnet")).toEqual([]);
  });

  it("links Telegram with a one-time deep link", async () => {
    const r = await call("POST", "/v1/telegram/link", await sign("amara", "telegram.link"));
    expect(r.json.url).toMatch(/^https:\/\/t\.me\/behest_test_bot\?start=[\w-]{32}$/);
    const t = new URL(r.json.url).searchParams.get("start")!;
    expect(store.takeTelegramLink(t)).toBe("amara.testnet");
    expect(store.takeTelegramLink(t)).toBeNull();
  });

  it("saves per-kind preferences and watched plans the account belongs to", async () => {
    const p = await call("PUT", "/v1/preferences", await sign("amara", "preferences.set", { preferences: { reminder: false, vote: false, security: false, bogus: true } }));
    expect(p.json.preferences).toMatchObject({ reminder: false, vote: false, security: true, eligible: true });
    expect(p.json.preferences.bogus).toBeUndefined();
    const w = await call("PUT", "/v1/watches", await sign("amara", "watches.set", { owners: ["kemi.testnet", "stranger.testnet", "Not Valid"] }));
    expect(w.json).toEqual({ watches: ["kemi.testnet"], refused: ["stranger.testnet"] });
    const list = await call("GET", "/v1/contacts", undefined, await session("amara"));
    expect(list.json.watches).toEqual(["kemi.testnet"]);
    expect(list.json.preferences.reminder).toBe(false);
  });

  it("lets a council member send a DAO's notices to the whole council (D26)", async () => {
    const dao = "family.sputnikv2.testnet";
    expect((await call("PUT", "/v1/council", await sign("amara", "council.set", { dao, enabled: true }))).json.code).toBe("NOT_COUNCIL");
    expect((await call("PUT", "/v1/council", await sign("kemi", "council.set", { dao: "amara.testnet", enabled: true }))).json.code).toBe("NOT_A_DAO");
    expect((await call("PUT", "/v1/council", await sign("kemi", "council.set", { dao: "rpc.sputnikv2.testnet", enabled: true }))).json.code).toBe("RPC");
    expect((await call("PUT", "/v1/council", await sign("kemi", "council.set", { dao, enabled: "yes" }))).json.code).toBe("BAD_REQUEST");
    const r = await call("PUT", "/v1/council", await sign("kemi", "council.set", { dao, enabled: true }));
    expect(r.json).toEqual({ dao, enabled: true, members: ["kemi.testnet", "dayo.testnet"] });
    expect(store.council(dao)?.enabled_by).toBe("kemi.testnet");
    expect((await call("GET", "/v1/contacts", undefined, await session("kemi"))).json.councils).toEqual([dao]);
    await call("PUT", "/v1/council", await sign("kemi", "council.set", { dao, enabled: false }));
    expect(store.council(dao)).toBeUndefined();
  });

  it("validates input", async () => {
    expect((await call("POST", "/v1/contacts", await sign("kemi", "contacts.add", { channel: "email", address: "not-an-email" }))).json.code).toBe("BAD_EMAIL");
    expect((await call("POST", "/v1/contacts", await sign("kemi", "contacts.add", { channel: "sms", address: "1" }))).json.code).toBe("BAD_CHANNEL");
    expect((await call("POST", "/v1/contacts", await sign("kemi", "contacts.add", { channel: "webhook", url: "ftp://x" }))).json.code).toBe("BAD_URL");
    expect((await call("GET", "/nope")).status).toBe(404);
  });
});
