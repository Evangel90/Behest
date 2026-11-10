import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermanentError, RejectedError, TransientError, type Outgoing, type Sender } from "../src/channels/types.js";
import type { WebhookSender } from "../src/channels/webhook.js";
import { Store } from "../src/db.js";
import type { Notice } from "../src/diff.js";
import { Bucket, Engine, OPERATOR } from "../src/engine.js";

class Fake implements Sender {
  sent: Outgoing[] = [];
  fail: (() => Error | null) | null = null;
  async send(m: Outgoing) {
    const e = this.fail?.();
    if (e) throw e;
    this.sent.push(m);
  }
}

const notice = (o: Partial<Notice> = {}): Notice => ({ key: "kemi.testnet:overdue:0", owner: "kemi.testnet", kind: "overdue", to: ["owner", "guardians"], subject: "Kemi hasn't checked in", text: "Kemi hasn't checked in.", links: [], ...o });

function setup(cfg: Partial<{ maxAttempts: number; operator: string; rate: number }> = {}) {
  const store = new Store();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const email = new Fake();
  const telegram = new Fake();
  const webhook = Object.assign(new Fake(), { posts: [] as string[], async post(url: string, _s: string | null, m: Outgoing) { webhook.posts.push(url); await webhook.send(m); } });
  const engine = new Engine(
    store,
    { maxAttempts: cfg.maxAttempts ?? 3, retryBaseMs: 1000, rate: { email: cfg.rate ?? 100, telegram: cfg.rate ?? 100, webhook: cfg.rate ?? 100 }, publicUrl: "https://notify.example", appUrl: "https://app.example", operatorWebhookUrl: cfg.operator, operatorWebhookSecret: undefined },
    { email, telegram, webhook: webhook as unknown as WebhookSender },
    () => {},
    clock.now,
  );
  return { store, engine, clock, email, telegram, webhook };
}

describe("fan-out", () => {
  it("records each notice once and queues one delivery per recipient contact", () => {
    const { store, engine } = setup();
    const kemiMail = store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    store.addContact({ account: "kemi.testnet", channel: "telegram", address: "42", status: "active" });
    store.addContact({ account: "dayo.testnet", channel: "webhook", address: "https://h.example/x", secret: "s", status: "active" });
    store.addContact({ account: "dayo.testnet", channel: "email", address: "pending@x.io", status: "pending" });
    store.addContact({ account: "stranger.testnet", channel: "email", address: "s@x.io", status: "active" });
    expect(engine.fanOut(notice(), ["kemi.testnet", "dayo.testnet"])).toBe(true);
    expect(engine.fanOut(notice(), ["kemi.testnet", "dayo.testnet"])).toBe(false);
    const ds = store.deliveries("kemi.testnet:overdue:0");
    expect(ds.map((d) => [d.account, d.channel])).toEqual([
      ["dayo.testnet", "webhook"],
      ["kemi.testnet", "email"],
      ["kemi.testnet", "telegram"],
    ]);
    expect(ds.find((d) => d.channel === "email")!.target).toBe(String(kemiMail.id));
  });

  it("respects per-account, per-kind preferences; security notices can't be muted", () => {
    const { store, engine } = setup();
    store.addContact({ account: "amara.testnet", channel: "email", address: "a@x.io", status: "active" });
    store.setPrefs("amara.testnet", { approved: false, security: false });
    engine.fanOut(notice({ key: "k1", kind: "approved" }), ["amara.testnet"]);
    engine.fanOut(notice({ key: "k2", kind: "eligible" }), ["amara.testnet"]);
    expect(store.deliveries("k1")).toEqual([]);
    expect(store.deliveries("k2")).toHaveLength(1);
    expect(store.prefs("amara.testnet").approved).toBe(false);
    const key = engine.security("amara.testnet", "Email added", "x");
    expect(store.deliveries(key)).toHaveLength(1);
  });

  it("feeds the operator webhook every notice", async () => {
    const { store, engine, webhook } = setup({ operator: "http://ops.internal/feed" });
    engine.fanOut(notice(), []);
    expect(store.deliveries(notice().key).map((d) => d.target)).toEqual([OPERATOR]);
    await engine.dispatch();
    expect(webhook.posts).toEqual(["http://ops.internal/feed"]);
  });
});

describe("delivery", () => {
  it("retries a failing channel with backoff without repeating the one that succeeded", async () => {
    const { store, engine, clock, email, webhook } = setup({ maxAttempts: 5 });
    store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    store.addContact({ account: "kemi.testnet", channel: "webhook", address: "https://h.example/x", secret: "s", status: "active" });
    let down = true;
    webhook.fail = () => (down ? new TransientError("webhook 503") : null);
    engine.fanOut(notice(), ["kemi.testnet"]);
    expect(await engine.dispatch()).toMatchObject({ sent: 1, retry: 1 });
    const hook = store.deliveries(notice().key).find((d) => d.channel === "webhook")!;
    expect(hook).toMatchObject({ status: "pending", attempts: 1, last_error: "webhook 503" });
    expect(hook.next_ms - clock.now()).toBeGreaterThanOrEqual(800);
    // nothing is due before the backoff ends
    expect(await engine.dispatch()).toMatchObject({ sent: 0, retry: 0 });
    clock.advance(1300);
    await engine.dispatch(); // second failure: backoff doubles
    const again = store.deliveries(notice().key).find((d) => d.channel === "webhook")!;
    expect(again.attempts).toBe(2);
    expect(again.next_ms - clock.now()).toBeGreaterThanOrEqual(1600);
    down = false;
    clock.advance(10_000);
    expect(await engine.dispatch()).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
    expect(webhook.sent).toHaveLength(1);
    expect(store.deliveries(notice().key).map((d) => d.status)).toEqual(["sent", "sent"]);
    // and a sent delivery never goes out again
    clock.advance(10_000_000);
    expect(await engine.dispatch()).toMatchObject({ sent: 0 });
  });

  it("gives up after the attempt cap and records why", async () => {
    const { store, engine, clock, email } = setup({ maxAttempts: 3 });
    store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    email.fail = () => new TransientError("smtp 421: try later");
    engine.fanOut(notice(), ["kemi.testnet"]);
    for (let i = 0; i < 5; i++) {
      await engine.dispatch();
      clock.advance(60_000);
    }
    const [d] = store.deliveries(notice().key);
    expect(d).toMatchObject({ status: "failed", attempts: 3 });
    expect(d!.last_error).toContain("gave up after 3 attempts");
  });

  it("honours a channel's retry-after hint", async () => {
    const { store, engine, clock, telegram } = setup();
    store.addContact({ account: "kemi.testnet", channel: "telegram", address: "42", status: "active" });
    telegram.fail = () => new TransientError("429", 30_000);
    engine.fanOut(notice(), ["kemi.testnet"]);
    await engine.dispatch();
    expect(store.deliveries(notice().key)[0]!.next_ms - clock.now()).toBeGreaterThanOrEqual(30_000);
  });

  it("disables a contact that can never receive again and drops its queue", async () => {
    const { store, engine, telegram } = setup();
    const c = store.addContact({ account: "kemi.testnet", channel: "telegram", address: "42", status: "active" });
    telegram.fail = () => new PermanentError("telegram 403: bot was blocked by the user");
    engine.fanOut(notice({ key: "a" }), ["kemi.testnet"]);
    engine.fanOut(notice({ key: "b" }), ["kemi.testnet"]);
    await engine.dispatch(1);
    expect(store.contact(c.id)).toMatchObject({ status: "disabled", disabled_reason: "telegram 403: bot was blocked by the user" });
    expect(store.deliveries("a")[0]!.status).toBe("failed");
    expect(store.deliveries("b")[0]!.status).toBe("cancelled");
    // later notices skip it
    engine.fanOut(notice({ key: "c" }), ["kemi.testnet"]);
    expect(store.deliveries("c")).toEqual([]);
  });

  it("fails a rejected message at once but keeps the contact", async () => {
    const { store, engine, webhook } = setup();
    const c = store.addContact({ account: "kemi.testnet", channel: "webhook", address: "https://h.example/x", secret: "s", status: "active" });
    webhook.fail = () => new RejectedError("webhook 400");
    engine.fanOut(notice(), ["kemi.testnet"]);
    await engine.dispatch();
    expect(store.deliveries(notice().key)[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(store.contact(c.id)!.status).toBe("active");
  });

  it("cancels deliveries to a removed contact", async () => {
    const { store, engine, email } = setup();
    const c = store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    engine.fanOut(notice(), ["kemi.testnet"]);
    store.removeContact(c.id);
    await engine.dispatch();
    expect(email.sent).toEqual([]);
    expect(store.deliveries(notice().key)[0]!.status).toBe("cancelled");
  });

  it("rate-limits each channel", async () => {
    const { store, engine, clock, email } = setup({ rate: 2 });
    for (let i = 0; i < 5; i++) store.addContact({ account: `a${i}.testnet`, channel: "email", address: `a${i}@x.io`, status: "active" });
    engine.fanOut(notice(), ["a0.testnet", "a1.testnet", "a2.testnet", "a3.testnet", "a4.testnet"]);
    expect(await engine.dispatch()).toMatchObject({ sent: 2, throttled: 3 });
    clock.advance(1000);
    expect((await engine.dispatch()).sent).toBe(2);
    clock.advance(1000);
    await engine.dispatch();
    expect(email.sent).toHaveLength(5);
    const b = new Bucket(1, 0);
    expect([b.take(0), b.take(10), b.take(1000)]).toEqual([true, false, true]);
  });

  it("gives each delivery a stable id and links to unsubscribe and settings", async () => {
    const { store, engine, email } = setup();
    store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    engine.fanOut(notice(), ["kemi.testnet"]);
    await engine.dispatch();
    const m = email.sent[0]!;
    expect(m.deliveryId).toMatch(/^[0-9a-f]{32}$/);
    expect(m.unsubscribeUrl).toMatch(/^https:\/\/notify\.example\/v1\/unsubscribe\?token=/);
    expect(m.settingsUrl).toBe("https://app.example/notifications");
  });
});

describe("restart safety", () => {
  it("keeps notices, deliveries and contacts across a restart, and imports the old JSON state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notifier-"));
    const legacy = join(dir, "state.json");
    writeFileSync(legacy, JSON.stringify({ owners: ["kemi.testnet"], sent: ["kemi.testnet:overdue:0"], last: { "kemi.testnet": { status: "Overdue" } } }));
    const path = join(dir, "n.db");
    const a = new Store(path);
    expect(a.importLegacy(legacy)).toBe(1);
    expect(existsSync(legacy)).toBe(false);
    a.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    a.close();
    const b = new Store(path);
    expect(b.hasNotice("kemi.testnet:overdue:0")).toBe(true);
    expect(b.snapshot("kemi.testnet")?.view.status).toBe("Overdue");
    expect(b.activeContacts("kemi.testnet")).toHaveLength(1);
    expect(b.importLegacy(legacy)).toBe(0);
    b.close();
  });
});
