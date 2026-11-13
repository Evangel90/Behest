// People an owner names with an email address: their wallets (Privy), the
// owner-scoped contact, the "you were named" notice and the HTTP API.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { emailNotice } from "../src/channels/templates.js";
import { loadConfig } from "../src/config.js";
import { Store, scopeOf } from "../src/db.js";
import type { PlanView } from "../src/diff.js";
import { Engine } from "../src/engine.js";
import { PrivyClient, PrivyError, segwitAddress, type EmailWallets } from "../src/privy.js";
import { Watcher } from "../src/watcher.js";
import { envelope, newSigner } from "./helpers.js";

const ETH = "0x46b29dCe9FD54f3f76A49FAcc60d99a104742247";
const NEAR = "16b09a4828c66ef7435ec9b79822bbb568eb8655bfb5a72be0d03b02808fc352";
// A real key/address pair from Privy (bitcoin-segwit wallet, mainnet form).
const BTC_PK = "02907a09c9d2cdf02da9793c13be3930a90f86ec368b30bb9b0b510047043f331e";
const BTC_MAIN = "bc1q6w2tsrzr2p76d26rndtw3s8k2pcwc8mchtgv63";

const wallet = (chain_type: string, address: string, public_key?: string) => ({ type: "wallet", chain_type, address, wallet_client_type: "privy", public_key });
const fullUser = (id = "did:privy:1") => ({ id, linked_accounts: [{ type: "email", address: "amara@example.com" }, wallet("ethereum", ETH), wallet("near", NEAR, `00${NEAR}`), wallet("bitcoin-segwit", BTC_MAIN, BTC_PK)] });

/** A scripted Privy REST API. */
function fakePrivy(script: (method: string, path: string, body: any) => { status: number; body?: unknown }) {
  const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://privy.test/v1", "");
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method ?? "GET", path, body, headers: init.headers as Record<string, string> });
    const r = script(init.method ?? "GET", path, body);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { calls, client: new PrivyClient({ appId: "app", secret: "s3cret", apiBase: "https://privy.test/v1", btcHrp: "tb" }, f) };
}

describe("wallets for an email address", () => {
  it("derives the SegWit address of a key for either network", () => {
    expect(segwitAddress(BTC_PK, "bc")).toBe(BTC_MAIN);
    expect(segwitAddress(BTC_PK, "tb")).toMatch(/^tb1q[0-9a-z]{38}$/);
    expect(() => segwitAddress("04" + "11".repeat(64), "tb")).toThrow(PrivyError);
  });

  it("creates the user with all three wallets when the address is new", async () => {
    const { calls, client } = fakePrivy((m, p) => (p === "/users/email/address" ? { status: 404, body: {} } : m === "POST" && p === "/users" ? { status: 200, body: fullUser() } : { status: 500 }));
    const w = await client.ensure("amara@example.com");
    expect(w).toEqual({ userId: "did:privy:1", eth: ETH.toLowerCase(), near: NEAR, btc: segwitAddress(BTC_PK, "tb") });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /users/email/address", "POST /users"]);
    expect(calls[1]!.body).toEqual({ linked_accounts: [{ type: "email", address: "amara@example.com" }], wallets: [{ chain_type: "ethereum" }, { chain_type: "near" }, { chain_type: "bitcoin-segwit" }] });
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("app:s3cret").toString("base64")}`);
    expect(calls[0]!.headers["privy-app-id"]).toBe("app");
  });

  it("returns the same wallets for a known address and adds only what is missing", async () => {
    const known = fakePrivy((_m, p) => (p === "/users/email/address" ? { status: 200, body: fullUser() } : { status: 500 }));
    expect((await known.client.ensure("amara@example.com")).eth).toBe(ETH.toLowerCase());
    expect(known.calls).toHaveLength(1);

    // Signed in once before with only an Ethereum wallet (and an external wallet that must not be mistaken for it).
    const partial = { id: "did:privy:2", linked_accounts: [{ type: "wallet", chain_type: "ethereum", address: "0x" + "9".repeat(40), wallet_client_type: "metamask" }, wallet("ethereum", ETH)] };
    const some = fakePrivy((_m, p) => (p === "/users/email/address" ? { status: 200, body: partial } : p === "/users/did%3Aprivy%3A2/wallets" ? { status: 200, body: fullUser("did:privy:2") } : { status: 500 }));
    const w = await some.client.ensure("amara@example.com");
    expect(w.eth).toBe(ETH.toLowerCase());
    expect(some.calls[1]!.body).toEqual({ wallets: [{ chain_type: "near" }, { chain_type: "bitcoin-segwit" }] });
  });

  it("reads the user again after losing a creation race, and fails plainly otherwise", async () => {
    let lookups = 0;
    const race = fakePrivy((_m, p) => (p === "/users/email/address" ? (lookups++ === 0 ? { status: 404 } : { status: 200, body: fullUser() }) : { status: 409, body: { error: "exists" } }));
    expect((await race.client.ensure("amara@example.com")).near).toBe(NEAR);
    await expect(fakePrivy(() => ({ status: 401, body: { error: "bad key" } })).client.ensure("a@b.example")).rejects.toBeInstanceOf(PrivyError);
    await expect(fakePrivy((_m, p) => (p === "/users/email/address" ? { status: 200, body: { id: "x", linked_accounts: [wallet("ethereum", ETH)] } } : { status: 200, body: { id: "x", linked_accounts: [wallet("ethereum", ETH)] } })).client.ensure("a@b.example")).rejects.toThrow(/no usable wallets/);
  });

  it("is configured by PRIVY_APP_ID and PRIVY_APP_SECRET together", () => {
    const base = { BEHEST_CONTRACT_ID: "behest.testnet" };
    expect(loadConfig(base).privy).toBeUndefined();
    expect(loadConfig({ ...base, PRIVY_APP_ID: "app" }).privy).toBeUndefined();
    expect(loadConfig({ ...base, PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "s" }).privy).toEqual({ appId: "app", secret: "s", apiBase: "https://api.privy.io/v1", btcHrp: "tb" });
    expect(loadConfig({ BEHEST_CONTRACT_ID: "behest.near", PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "s" }).privy!.btcHrp).toBe("bc");
  });
});

const person = (o: Partial<Parameters<Store["putPerson"]>[0]> = {}) => ({ owner: "kemi.testnet", account: ETH.toLowerCase(), role: "heir" as const, email: "amara@example.com", label: null, by_email: 1, announce: 0, near: NEAR, btc: "tb1qx", ...o });
const engineOf = (store: Store) => new Engine(store, { maxAttempts: 3, retryBaseMs: 1000, rate: { email: 10, telegram: 10, webhook: 10 }, publicUrl: "http://n", appUrl: "http://app" }, {});
const noticeFor = (owner: string, key: string) => ({ key, owner, kind: "eligible" as const, to: [], subject: "s", text: "t", links: [] });

describe("an address the owner supplied", () => {
  it("hears only about that owner's plan, until its own account confirms it", () => {
    const store = new Store();
    const engine = engineOf(store);
    store.putPerson(person());
    const c = store.contactBy(ETH.toLowerCase(), "email", "amara@example.com")!;
    expect(c.status).toBe("active");
    expect(scopeOf(c)).toEqual(["kemi.testnet"]);
    engine.fanOut(noticeFor("kemi.testnet", "k1"), [ETH.toLowerCase()]);
    engine.fanOut(noticeFor("bola.testnet", "b1"), [ETH.toLowerCase()]);
    expect(store.deliveries("k1")).toHaveLength(1);
    expect(store.deliveries("b1")).toHaveLength(0);
    // nothing about the account's own settings goes there, and its own plan isn't watched on its behalf
    engine.security(ETH.toLowerCase(), "Telegram linked", "…");
    expect(store.due(Date.now() + 1).filter((d) => d.notice_key.startsWith("security:"))).toHaveLength(0);
    expect(store.subscribedAccounts()).toEqual([]);
    // a second owner names the same person
    store.putPerson(person({ owner: "bola.testnet", role: "guardian" }));
    expect(scopeOf(store.contact(c.id)!)).toEqual(["kemi.testnet", "bola.testnet"]);
    engine.fanOut(noticeFor("bola.testnet", "b2"), [ETH.toLowerCase()]);
    expect(store.deliveries("b2")).toHaveLength(1);
    // confirmed by the account itself: an ordinary contact from then on
    store.activate(c.id);
    expect(scopeOf(store.contact(c.id)!)).toBeNull();
    engine.fanOut(noticeFor("chidi.testnet", "c1"), [ETH.toLowerCase()]);
    expect(store.deliveries("c1")).toHaveLength(1);
  });

  it("is dropped with the last seat that used it, moved when the address changes, and never revived after an unsubscribe", () => {
    const store = new Store();
    store.putPerson(person({ role: "heir" }));
    store.putPerson(person({ role: "guardian" }));
    const id = store.contactBy(ETH.toLowerCase(), "email", "amara@example.com")!.id;
    expect(store.removePerson("kemi.testnet", ETH.toLowerCase(), "heir")).toBe(true);
    expect(store.contact(id)).toBeDefined(); // the guardian seat still uses it
    expect(store.removePerson("kemi.testnet", ETH.toLowerCase(), "guardian")).toBe(true);
    expect(store.contact(id)).toBeUndefined();
    expect(store.removePerson("kemi.testnet", ETH.toLowerCase(), "guardian")).toBe(false);

    // wallet + email: the owner corrects the address
    store.putPerson(person({ account: "dayo.testnet", by_email: 0, role: "guardian", email: "old@example.com" }));
    store.markNamed("kemi.testnet", "dayo.testnet", "guardian");
    const p = store.putPerson(person({ account: "dayo.testnet", by_email: 0, role: "guardian", email: "new@example.com" }));
    expect(p.named_ms).toBeNull(); // the new address hasn't been told yet
    expect(store.contactBy("dayo.testnet", "email", "old@example.com")).toBeUndefined();
    expect(store.contactBy("dayo.testnet", "email", "new@example.com")!.status).toBe("active");

    // unsubscribed: naming again changes nothing
    const c = store.contactBy("dayo.testnet", "email", "new@example.com")!;
    store.disable(c.id, "unsubscribed");
    store.putPerson(person({ owner: "bola.testnet", account: "dayo.testnet", by_email: 0, role: "guardian", email: "new@example.com" }));
    expect(store.contact(c.id)!.status).toBe("disabled");
    expect(store.activeContacts("dayo.testnet")).toHaveLength(0);
  });

  it("says in the email who supplied the address", () => {
    const store = new Store();
    store.putPerson(person());
    const contact = store.contactBy(ETH.toLowerCase(), "email", "amara@example.com")!;
    const notice = { ...noticeFor("kemi.testnet", "k"), recipients: [], created_ms: 0 };
    const m = emailNotice({ notice, account: contact.account, contact, deliveryId: "d", unsubscribeUrl: "http://n/u", settingsUrl: "http://app/notifications" });
    expect(m.text).toContain("the owner of this plan (Kemi) named you in it on Behest and gave this address");
    expect(m.text).not.toContain("asked Behest to send");
    store.activate(contact.id);
    expect(emailNotice({ notice, account: contact.account, contact: store.contact(contact.id)!, deliveryId: "d", unsubscribeUrl: "u", settingsUrl: "s" }).text).toContain("asked Behest to send");
  });
});

const MIN = 60_000;
const planOf = (owner: string, guardians: string[], heirs: string[]): PlanView => ({
  status: "Active",
  overdue_at_ms: 100 * MIN,
  now_ms: MIN,
  plan: { owner, last_check_in_ms: 0, policy: { check_in_interval_ms: 100 * MIN, grace_ms: 0, quorum: 1, guardians, heirs: heirs.map((account_id) => ({ account_id })) }, proposal: null, proposals_opened: 0 },
});

describe("telling people they were named", () => {
  it("waits for the plan on-chain to name them, tells guardians always and heirs only when asked, once", async () => {
    const store = new Store();
    const engine = engineOf(store);
    const plans = new Map<string, PlanView>();
    const view = async <T,>(method: string, args: Record<string, unknown>): Promise<T> => (method === "list_open_releases" ? ([] as T) : method === "get_plan" ? ((plans.get(String(args.owner)) ?? null) as T) : method === "get_config" ? ({} as T) : (null as T));
    const w = new Watcher(store, engine, view, { owners: [], contractId: "c", appUrl: "http://app/" });
    const heir = "0x" + "a".repeat(40);
    const quiet = "0x" + "b".repeat(40);
    store.setOwnerName("kemi.testnet", "Kemi Adeyemi");
    store.putPerson(person({ account: heir, role: "heir", email: "amara@example.com", announce: 1 }));
    store.putPerson(person({ account: quiet, role: "heir", email: "tobi@example.com", announce: 0 }));
    store.putPerson(person({ account: "dayo.testnet", role: "guardian", email: "dayo@example.com", by_email: 0, announce: 1 }));

    // no plan yet: the owner is read every round, nobody is written to
    expect(await w.tick()).toMatchObject({ owners: 1, notices: 0 });
    // a plan that doesn't name them (yet)
    plans.set("kemi.testnet", planOf("kemi.testnet", ["funmi.testnet"], ["someone.testnet"]));
    expect((await w.tick()).notices).toBe(0);
    expect(store.ownersWithUnnamed()).toEqual(["kemi.testnet"]);

    plans.set("kemi.testnet", planOf("kemi.testnet", ["dayo.testnet"], [heir, quiet]));
    expect((await w.tick()).notices).toBe(2);
    const g = store.notice("kemi.testnet:named:dayo.testnet:guardian")!;
    expect(g.subject).toBe("Kemi Adeyemi named you a guardian");
    expect(g.text).not.toContain("Sign in to Behest with this email address"); // they have their own wallet
    expect(g.links).toEqual([{ label: "Open the plan in Behest", url: "http://app/plan/kemi.testnet" }]);
    expect(store.deliveries(g.key)).toHaveLength(1);
    const h = store.notice(`kemi.testnet:named:${heir}:heir`)!;
    expect(h.text).toContain("Sign in to Behest with this email address to see it; you don't need a wallet.");
    expect(`${g.text} ${h.text}`).not.toMatch(/\b(died|death|deceased|dies)\b/i);
    expect(store.hasNotice(`kemi.testnet:named:${quiet}:heir`)).toBe(false);

    // told once; the owner is no longer read just for this
    expect(store.ownersWithUnnamed()).toEqual([]);
    expect((await w.tick()).notices).toBe(0);
  });
});

describe("people API", () => {
  const ORIGIN = "http://localhost:3000";
  const kemi = newSigner();
  const heirKey = newSigner();
  let base = "";
  let store: Store;
  let close: () => void;
  let ensured: string[] = [];
  let fail = false;
  const wallets: EmailWallets = { userId: "did:privy:1", eth: ETH.toLowerCase(), near: NEAR, btc: "tb1qheir" };

  beforeAll(async () => {
    store = new Store();
    const server = createApi({
      store,
      engine: engineOf(store),
      cfg: { contractId: "behest-ekkr6.testnet", publicUrl: "http://notify.test", appUrl: "http://localhost:3000", allowedOrigins: [ORIGIN], signRecipient: "behest-notifier", signMaxAgeMs: 300_000, trustProxy: false, webhookAllowInsecure: true },
      keys: async (a) => (a === "kemi.testnet" ? [kemi.publicKey] : a === "amara.testnet" ? [heirKey.publicKey] : null),
      privy: {
        ensure: async (email) => {
          ensured.push(email);
          if (fail) throw new PrivyError("privy create 500", 500);
          return wallets;
        },
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const session = async (signer = kemi, account = "kemi.testnet") => ({ authorization: `Bearer ${(await call("POST", "/v1/session", await envelope(signer.signer, account, "session"))).json.token}` });

  it("names a person by email: their wallets come back and the address is theirs to hear on", async () => {
    expect((await call("GET", "/v1/info")).json).toMatchObject({ email_wallets: true, people_roles: ["heir", "guardian", "standby", "delay", "recipient"] });
    expect((await call("POST", "/v1/people", { email: "a@b.example", role: "heir" })).status).toBe(401);
    const auth = await session();
    const r = await call("POST", "/v1/people", { email: " Amara@Example.com ", role: "heir", label: "Amara", name: "Kemi A." }, auth);
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ name: "Kemi A.", person: { account: ETH.toLowerCase(), role: "heir", email: "amara@example.com", label: "Amara", by_email: true, announce: false, near: NEAR, btc: "tb1qheir", told_ms: null, email_status: "active" } });
    expect(ensured).toEqual(["amara@example.com"]);
    // guardians are always told; an account can be given instead of creating one
    const g = await call("POST", "/v1/people", { email: "dayo@example.com", role: "guardian", account: "Dayo.testnet" }, auth);
    expect(g.json.person).toMatchObject({ account: "dayo.testnet", by_email: false, announce: true, near: null, btc: null });
    expect(ensured).toHaveLength(1);
    const list = await call("GET", "/v1/people", undefined, auth);
    expect(list.json.name).toBe("Kemi A.");
    expect(list.json.people.map((p: { account: string }) => p.account)).toEqual([ETH.toLowerCase(), "dayo.testnet"]);
  });

  it("refuses bad input and reports a Privy outage without leaving a half-made person", async () => {
    const auth = await session();
    expect((await call("POST", "/v1/people", { email: "nope", role: "heir" }, auth)).json.code).toBe("BAD_EMAIL");
    expect((await call("POST", "/v1/people", { email: "a@b.example", role: "owner" }, auth)).json.code).toBe("BAD_ROLE");
    expect((await call("POST", "/v1/people", { email: "a@b.example", role: "heir", account: "Not An Account" }, auth)).json.code).toBe("BAD_ACCOUNT");
    expect((await call("POST", "/v1/people", { email: "a@b.example", role: "heir", name: "Behest <https://evil.example>" }, auth)).json.code).toBe("BAD_NAME");
    expect((await call("PUT", "/v1/people/name", { name: "Mum" }, auth)).json.name).toBe("Mum");
    expect((await call("PUT", "/v1/people/name", { name: "" }, auth)).json.name).toBeNull();
    fail = true;
    const before = store.countPeople("kemi.testnet");
    const r = await call("POST", "/v1/people", { email: "new@example.com", role: "heir" }, auth);
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("EMAIL_WALLETS_FAILED");
    expect(store.countPeople("kemi.testnet")).toBe(before);
    fail = false;
  });

  it("lets anyone make sure an address has wallets, without saying what they are", async () => {
    ensured = [];
    const r = await call("POST", "/v1/email-wallets", { email: "New@Example.com" });
    expect(r.json).toEqual({ ok: true });
    expect(ensured).toEqual(["new@example.com"]);
    expect((await call("POST", "/v1/email-wallets", { email: "nope" })).json.code).toBe("BAD_EMAIL");
    let last = 200;
    for (let i = 0; i < 8; i++) last = (await call("POST", "/v1/email-wallets", { email: "x@example.com" })).status;
    expect(last).toBe(429);
  });

  it("unsubscribing keeps the address off for good, and the owner sees that", async () => {
    const auth = await session();
    const c = store.contactBy(ETH.toLowerCase(), "email", "amara@example.com")!;
    expect((await call("POST", `/v1/unsubscribe?token=${c.unsub_token}`)).status).toBe(200);
    expect(store.contact(c.id)!.status).toBe("disabled");
    await call("POST", "/v1/people", { email: "amara@example.com", role: "heir", label: "Amara" }, auth);
    const list = await call("GET", "/v1/people", undefined, auth);
    expect(list.json.people.find((p: { account: string }) => p.account === ETH.toLowerCase()).email_status).toBe("unsubscribed");
    expect(store.activeContacts(ETH.toLowerCase())).toHaveLength(0);
  });

  it("removes a person, and only the owner who named them can", async () => {
    const auth = await session();
    const other = await session(heirKey, "amara.testnet");
    expect((await call("DELETE", `/v1/people/dayo.testnet?role=guardian`, undefined, other)).status).toBe(404);
    expect((await call("DELETE", `/v1/people/dayo.testnet?role=heir`, undefined, auth)).status).toBe(404);
    expect((await call("DELETE", `/v1/people/dayo.testnet?role=guardian`, undefined, auth)).json).toEqual({ ok: true });
    expect(store.contactBy("dayo.testnet", "email", "dayo@example.com")).toBeUndefined();
  });

  it("the account an address was created for confirms it by signing, with no second email", async () => {
    // amara.testnet stands in for the wallet created for her address
    store.putPerson(person({ account: "amara.testnet", email: "amara2@example.com" }));
    const c = store.contactBy("amara.testnet", "email", "amara2@example.com")!;
    expect(scopeOf(c)).toEqual(["kemi.testnet"]);
    const r = await call("POST", "/v1/contacts", await envelope(heirKey.signer, "amara.testnet", "contacts.add", { channel: "email", address: "amara2@example.com" }));
    expect(r.status).toBe(200);
    expect(r.json.contact).toMatchObject({ status: "active", added_by: null });
    expect(scopeOf(store.contact(c.id)!)).toBeNull();
  });
});
