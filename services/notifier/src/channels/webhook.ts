// Webhooks: signed JSON POSTs to URLs an account registered.
//
// Signature: X-Behest-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
// with X-Behest-Timestamp (unix seconds). Receivers recompute it with the
// secret shown once at registration and reject old timestamps.
//
// SSRF guard: https only (unless NOTIFY_WEBHOOK_ALLOW_INSECURE for local
// development), no credentials in the URL, no redirects, and every address
// the host resolves to must be public. The check runs inside the socket's DNS
// lookup, so the address that is checked is the address that is connected to
// (no DNS-rebinding window).
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { webhookBody } from "./templates.js";
import { PermanentError, RejectedError, TransientError, type Outgoing, type Sender } from "./types.js";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 can embed private IPv4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** True for addresses a webhook may connect to. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked.check(ip, "ipv4");
  if (v === 6) {
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) is judged as the IPv4 address
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    const hex = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export class UrlError extends Error {}

export const MAX_URL = 2048;

/** Static checks on a webhook URL (scheme, credentials, literal addresses). DNS is checked at connect time. */
export function checkWebhookUrl(raw: string, allowInsecure = false): URL {
  if (typeof raw !== "string" || raw.length > MAX_URL) throw new UrlError("URL is missing or too long");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlError("not a valid URL");
  }
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:")) throw new UrlError("webhook URLs must use https");
  if (u.username || u.password) throw new UrlError("put credentials in the path or a query token, not user:pass@");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowInsecure) {
    if (isIP(host) && !isPublicAddress(host)) throw new UrlError("that address is private or local");
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) throw new UrlError("that host is private or local");
    if (u.port && !["443", "8443"].includes(u.port)) throw new UrlError("only ports 443 and 8443 are allowed");
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that refuses non-public answers. */
export function guardedLookup(allowPrivate: boolean, resolve: typeof dnsLookup = dnsLookup) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb) => {
    const opts = typeof options === "number" ? { family: options } : (options ?? {});
    resolve(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err, "", 0);
      const list = addrs as LookupAddress[];
      const bad = list.find((a) => !allowPrivate && !isPublicAddress(a.address));
      if (bad || !list.length) {
        const e = new Error(`refused: ${hostname} resolves to a private address`) as NodeJS.ErrnoException;
        e.code = "EPRIVATE";
        return cb(e, "", 0);
      }
      if (opts.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

export function sign(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** For receivers (and tests): checks a signature and that the timestamp is recent. */
export function verifyWebhook(secret: string, header: string, timestamp: string, body: string, toleranceS = 300, nowS = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > toleranceS) return false;
  const want = Buffer.from(sign(secret, ts, body));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface PostResult {
  status: number;
}

/** POST without following redirects, through the guarded lookup. */
export function guardedPost(url: URL, body: string, headers: Record<string, string>, allowPrivate: boolean, timeoutMs = 10_000): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: guardedLookup(allowPrivate) as never, timeout: timeoutMs },
      (res) => {
        res.resume(); // the response body is ignored
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

export class WebhookSender implements Sender {
  constructor(
    private contractId: string,
    private allowInsecure: boolean,
  ) {}

  async send(m: Outgoing) {
    if (!m.contact.secret) throw new PermanentError("webhook has no secret");
    await this.post(m.contact.address, m.contact.secret, m);
  }

  /** Also used for the operator feed: `trusted` (operator-configured) skips the SSRF guard and the secret is optional. */
  async post(rawUrl: string, secret: string | null, m: Outgoing, trusted = false) {
    const relaxed = trusted || this.allowInsecure;
    let url: URL;
    try {
      url = checkWebhookUrl(rawUrl, relaxed);
    } catch (e) {
      throw new PermanentError(`webhook URL refused: ${(e as Error).message}`);
    }
    const body = JSON.stringify(webhookBody(m, this.contractId));
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "Behest-Notifier/1",
      "x-behest-event": m.notice.kind,
      "x-behest-delivery": m.deliveryId,
      "x-behest-timestamp": String(ts),
    };
    if (secret) headers["x-behest-signature"] = sign(secret, ts, body);
    let r: PostResult;
    try {
      r = await guardedPost(url, body, headers, relaxed);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EPRIVATE") throw new PermanentError(err.message);
      throw new TransientError(`webhook: ${err.code ?? err.message}`);
    }
    if (r.status >= 200 && r.status < 300) return;
    if (r.status === 410) throw new PermanentError("webhook 410 Gone");
    if (r.status >= 300 && r.status < 400) throw new RejectedError(`webhook ${r.status}: redirects are not followed`);
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new RejectedError(`webhook ${r.status}`);
    throw new TransientError(`webhook ${r.status}`);
  }
}
