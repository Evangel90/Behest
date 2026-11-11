"use client";
// Client for the notifier service (services/notifier). Contacts never touch
// the chain: they live in the notifier's database, and every change is a
// NEP-413 message signed by the signed-in account (no transaction, no gas).
//  - persona sessions sign locally with the key this browser holds;
//  - wallet sessions ask the wallet (NEAR Connect `signMessage`);
//  - Ethereum-wallet sessions sign the same text with personal_sign (EIP-191).
// Reading your settings uses a short session token from one signature.
import { KeyPairSigner, type KeyPairString } from "near-api-js";
import { CONTRACT_ID } from "./config";
import { NOTIFIER_URL, NOTIFY_RECIPIENT } from "./config";
import { sharedConnector } from "./connector";
import { loadSandbox } from "./demo";
import type { Session } from "./session";

export type Channel = "email" | "telegram" | "webhook";

export interface KindInfo {
  kind: string;
  label: string;
  who: string;
  always_on: boolean;
}

export interface NotifierInfo {
  contract: string;
  recipient: string;
  channels: { email: boolean; telegram: false | { bot: string }; webhook: boolean };
  kinds: KindInfo[];
  limits: { email: number; telegram: number; webhook: number; watches: number };
  webhook_https_only: boolean;
}

export interface Contact {
  id: number;
  channel: Channel;
  address: string;
  label: string | null;
  status: "pending" | "active" | "disabled";
  created_ms: number;
  verified_ms: number | null;
  disabled_reason: string | null;
  telegram?: { username: string | null; name: string | null } | null;
  last_delivery: { status: string; at_ms: number; error: string | null } | null;
}

export interface RecentNotice {
  key: string;
  kind: string;
  owner: string;
  subject: string;
  text: string;
  links: { label: string; url: string }[];
  created_ms: number;
}

export interface Settings {
  account: string;
  contacts: Contact[];
  preferences: Record<string, boolean>;
  watches: string[];
  /** D26: DAOs whose notices this account sent to their whole council. */
  councils?: string[];
  recent: RecentNotice[];
}

export class NotifierError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const base = () => NOTIFIER_URL.replace(/\/$/, "");

async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NotifierError("UNREACHABLE", "The notification service isn't reachable right now.");
  }
  const json = (await res.json().catch(() => ({}))) as T & { code?: string; error?: string };
  if (!res.ok) throw new NotifierError(json.code ?? `HTTP_${res.status}`, json.error ?? "The notification service refused the request.");
  return json;
}

/** Same format as services/notifier/src/auth.ts `actionMessage`: a readable line, then the JSON the notifier acts on. */
export function actionMessage(summary: string, action: string, account: string, args: Record<string, unknown> = {}): string {
  const line = summary.replace(/[{}\n]/g, "");
  return `Behest notifications: ${line}\n${JSON.stringify({ app: "behest-notifier", v: 1, action, account, ts: Date.now(), ...args })}`;
}

export interface Envelope {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
  message: string;
  recipient: string;
}

/** An Ethereum account's envelope: the same message, signed with personal_sign. */
export interface Eip191Envelope {
  scheme: "eip191";
  accountId: string;
  message: string;
  signature: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** A NEP-413 signature by the session's NEAR account (test persona key or connected wallet). Signature and nonce are base64. */
export async function signNep413(session: Session, message: string, recipient: string, nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): Promise<{ publicKey: string; signature: string; nonce: string }> {
  if (session.kind === "persona") {
    const persona = Object.values(loadSandbox()?.personas ?? {}).find((p) => p.accountId === session.accountId);
    if (!persona) throw new NotifierError("NO_KEY", "This test persona's key isn't in this browser any more.");
    const signer = KeyPairSigner.fromSecretKey(persona.secretKey as KeyPairString);
    const s = await signer.signNep413Message(session.accountId, { message, recipient, nonce });
    return { publicKey: s.publicKey.toString(), signature: b64(s.signature), nonce: b64(nonce) };
  }
  // Wallet: the connector keeps the connected wallet in browser storage, so a second instance finds it.
  const connector = await sharedConnector();
  const { wallet } = await connector.getConnectedWallet();
  if (!wallet) throw new NotifierError("NO_WALLET", "Reconnect your wallet, then try again.");
  if (wallet.manifest.features?.signMessage === false) throw new NotifierError("NO_SIGN_MESSAGE", `${wallet.manifest.name} can't sign messages. Try another wallet.`);
  const s = await wallet.signMessage({ message, recipient, nonce, network: CONTRACT_ID.endsWith(".near") ? "mainnet" : "testnet", signerId: session.accountId });
  if (s.accountId && s.accountId !== session.accountId) throw new NotifierError("WRONG_ACCOUNT", `The wallet signed as ${s.accountId}.`);
  return { publicKey: s.publicKey, signature: s.signature, nonce: b64(nonce) };
}

/** Signs a notifier action as the session's account. */
export async function signAction(session: Session, summary: string, action: string, args: Record<string, unknown> = {}): Promise<Envelope | Eip191Envelope> {
  const message = actionMessage(summary, action, session.accountId, args);
  if (session.kind === "evm") {
    if (!session.personalSign) throw new NotifierError("NO_WALLET", "Reconnect your wallet, then try again.");
    return { scheme: "eip191", accountId: session.accountId, message, signature: await session.personalSign(message) };
  }
  const recipient = NOTIFY_RECIPIENT;
  const s = await signNep413(session, message, recipient);
  return { accountId: session.accountId, publicKey: s.publicKey, signature: s.signature, nonce: s.nonce, message, recipient };
}

// ---- session token, kept per tab
const TOKEN_KEY = (account: string) => `behest.notify.${account}`;
function storedToken(account: string): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY(account));
    const t = raw ? (JSON.parse(raw) as { token: string; expires_ms: number }) : null;
    return t && t.expires_ms > Date.now() + 60_000 ? t.token : null;
  } catch {
    return null;
  }
}

export const getInfo = () => request<NotifierInfo>("GET", "/v1/info");

/** Opens a notifier session for the signed-in account (one signature). */
export async function openSession(session: Session): Promise<string> {
  const existing = storedToken(session.accountId);
  if (existing) return existing;
  const env = await signAction(session, `view notification settings for ${session.accountId}`, "session");
  const r = await request<{ token: string; expires_ms: number }>("POST", "/v1/session", env);
  try {
    sessionStorage.setItem(TOKEN_KEY(session.accountId), JSON.stringify(r));
  } catch {}
  return r.token;
}

export function hasSession(account: string) {
  return storedToken(account) !== null;
}

export function forgetSession(account: string) {
  try {
    sessionStorage.removeItem(TOKEN_KEY(account));
  } catch {}
}

export const getSettings = (token: string) => request<Settings>("GET", "/v1/contacts", undefined, token);

export async function addEmail(session: Session, address: string) {
  return request<{ contact: Contact; message: string }>("POST", "/v1/contacts", await signAction(session, `send notices to ${address}`, "contacts.add", { channel: "email", address }));
}

export async function addWebhook(session: Session, url: string, label?: string) {
  return request<{ contact: Contact; secret: string; message: string }>("POST", "/v1/contacts", await signAction(session, `send notices to webhook ${new URL(url).host}`, "contacts.add", { channel: "webhook", url, label }));
}

export async function removeContact(session: Session, c: Contact) {
  return request<{ ok: true }>("DELETE", `/v1/contacts/${c.id}`, await signAction(session, `stop sending notices to ${c.channel} ${c.channel === "webhook" ? new URL(c.address).host : (c.label ?? c.address)}`, "contacts.remove", { id: c.id }));
}

export async function linkTelegram(session: Session) {
  return request<{ url: string; expires_ms: number }>("POST", "/v1/telegram/link", await signAction(session, "link a Telegram chat", "telegram.link"));
}

export async function savePreferences(session: Session, preferences: Record<string, boolean>) {
  return request<{ preferences: Record<string, boolean> }>("PUT", "/v1/preferences", await signAction(session, "choose which notices to receive", "preferences.set", { preferences }));
}

export async function saveWatches(session: Session, owners: string[]) {
  return request<{ watches: string[]; refused: string[] }>("PUT", "/v1/watches", await signAction(session, `watch ${owners.length} plan${owners.length === 1 ? "" : "s"}`, "watches.set", { owners }));
}

/** D26: a council member sends the DAO's notices to every council member (or stops). */
export async function setCouncil(session: Session, dao: string, enabled: boolean) {
  return request<{ dao: string; enabled: boolean; members: string[] }>(
    "PUT",
    "/v1/council",
    await signAction(session, `${enabled ? "send" : "stop sending"} ${dao}'s notices to its whole council`, "council.set", { dao, enabled }),
  );
}

export const resendConfirmation = (token: string, id: number) => request<{ ok: true }>("POST", `/v1/contacts/${id}/resend`, undefined, token);
export const testContact = (token: string, id: number) => request<{ ok: boolean; error?: string }>("POST", `/v1/contacts/${id}/test`, undefined, token);
