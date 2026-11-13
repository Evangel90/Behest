// Notifier configuration, all from the environment (see .env.example).
export interface Config {
  contractId: string;
  /** NEAR RPCs for views and key lookups: the main one first, then fallbacks. */
  nearRpcUrls: string[];
  intervalMs: number;
  dbPath: string;
  /** Legacy JSON state file, imported once into the database if present. */
  legacyStatePath: string;
  /** Extra owners to watch (operator list). */
  owners: string[];
  /** Operator feed: every notice, unsigned unless NOTIFY_WEBHOOK_SECRET is set. */
  operatorWebhookUrl?: string;
  operatorWebhookSecret?: string;

  /** HTTP API. */
  port: number;
  host: string;
  /** Where links in emails point (verify/unsubscribe); the API's public URL. */
  publicUrl: string;
  /** Behest web app, for "open the plan" links. */
  appUrl?: string;
  /** Origins allowed to call the API from a browser. */
  allowedOrigins: string[];
  /** NEP-413 `recipient` every signed request must name. */
  signRecipient: string;
  /** Accept signed requests issued at most this long ago (or ahead). */
  signMaxAgeMs: number;
  /** Trust X-Forwarded-For (behind a reverse proxy). */
  trustProxy: boolean;

  smtp?: { url?: string; host?: string; port: number; secure: boolean; user?: string; pass?: string; from: string; ignoreTls: boolean };
  /** Email over Brevo's HTTPS API, for hosts that block SMTP ports. Used instead of SMTP when set. */
  brevo?: { key: string; apiBase: string; from: string };
  telegram?: { token: string; username: string; apiBase: string; pollTimeoutS: number };
  /** Wallets for people named by email (PRIVY_APP_ID + PRIVY_APP_SECRET). The secret only ever asks for addresses. */
  privy?: { appId: string; secret: string; apiBase: string; btcHrp: "bc" | "tb" };

  /** Webhooks: allow http:// and private addresses (local development only). */
  webhookAllowInsecure: boolean;
  maxAttempts: number;
  retryBaseMs: number;
  /** Per-channel sends per second. */
  rate: { email: number; telegram: number; webhook: number };
}

/** Public testnet RPCs tried after NEAR_RPC_URL when NEAR_RPC_FALLBACK_URLS isn't set. */
const TESTNET_FALLBACKS = "https://test.rpc.fastnear.com,https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org";

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const bool = (s: string | undefined) => s === "1" || s === "true" || s === "yes";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const contractId = env.BEHEST_CONTRACT_ID ?? "";
  if (!contractId) throw new Error("missing env BEHEST_CONTRACT_ID");
  const port = Number(env.NOTIFY_PORT ?? 8790);
  const smtpFrom = env.SMTP_FROM ?? "";
  const smtpConfigured = Boolean(env.SMTP_URL || env.SMTP_HOST);
  if (smtpConfigured && !smtpFrom) throw new Error("SMTP is configured but SMTP_FROM is missing");
  const brevoKey = env.BREVO_API_KEY ?? "";
  const brevoFrom = env.EMAIL_FROM || smtpFrom;
  if (brevoKey && !brevoFrom) throw new Error("BREVO_API_KEY is set but EMAIL_FROM (or SMTP_FROM) is missing");
  const rpcUrls = [env.NEAR_RPC_URL || "https://rpc.testnet.fastnear.com", ...list(env.NEAR_RPC_FALLBACK_URLS ?? (contractId.endsWith(".testnet") ? TESTNET_FALLBACKS : ""))];
  const tgToken = env.TELEGRAM_BOT_TOKEN ?? "";
  const tgUser = (env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");
  if (tgToken && !tgUser) throw new Error("TELEGRAM_BOT_TOKEN is set but TELEGRAM_BOT_USERNAME is missing");
  return {
    contractId,
    nearRpcUrls: rpcUrls.filter((u, i) => rpcUrls.indexOf(u) === i),
    intervalMs: Number(env.NOTIFY_INTERVAL_MS ?? 30_000),
    dbPath: env.NOTIFY_DB ?? ".notifier.db",
    legacyStatePath: env.NOTIFY_STATE_FILE ?? ".notifier-state.json",
    owners: list(env.NOTIFY_OWNERS),
    operatorWebhookUrl: env.NOTIFY_WEBHOOK_URL || undefined,
    operatorWebhookSecret: env.NOTIFY_WEBHOOK_SECRET || undefined,
    port,
    host: env.NOTIFY_HOST ?? "0.0.0.0",
    publicUrl: (env.NOTIFY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    appUrl: env.NOTIFY_APP_URL || undefined,
    allowedOrigins: list(env.NOTIFY_ALLOWED_ORIGINS ?? "http://localhost:3000"),
    signRecipient: env.NOTIFY_SIGN_RECIPIENT ?? "behest-notifier",
    signMaxAgeMs: Number(env.NOTIFY_SIGN_MAX_AGE_MS ?? 5 * 60_000),
    trustProxy: bool(env.NOTIFY_TRUST_PROXY),
    smtp: smtpConfigured
      ? {
          url: env.SMTP_URL || undefined,
          host: env.SMTP_HOST || undefined,
          port: Number(env.SMTP_PORT ?? 587),
          secure: env.SMTP_SECURE ? bool(env.SMTP_SECURE) : Number(env.SMTP_PORT ?? 587) === 465,
          user: env.SMTP_USER || undefined,
          pass: env.SMTP_PASS || undefined,
          from: smtpFrom,
          ignoreTls: bool(env.SMTP_IGNORE_TLS),
        }
      : undefined,
    brevo: brevoKey ? { key: brevoKey, apiBase: (env.BREVO_API_BASE ?? "https://api.brevo.com/v3").replace(/\/$/, ""), from: brevoFrom } : undefined,
    privy:
      env.PRIVY_APP_ID && env.PRIVY_APP_SECRET
        ? { appId: env.PRIVY_APP_ID, secret: env.PRIVY_APP_SECRET, apiBase: (env.PRIVY_API_BASE ?? "https://api.privy.io/v1").replace(/\/$/, ""), btcHrp: contractId.endsWith(".near") ? "bc" : "tb" }
        : undefined,
    telegram: tgToken ? { token: tgToken, username: tgUser, apiBase: (env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/$/, ""), pollTimeoutS: Number(env.TELEGRAM_POLL_TIMEOUT_S ?? 25) } : undefined,
    webhookAllowInsecure: bool(env.NOTIFY_WEBHOOK_ALLOW_INSECURE),
    maxAttempts: Number(env.NOTIFY_MAX_ATTEMPTS ?? 8),
    retryBaseMs: Number(env.NOTIFY_RETRY_BASE_MS ?? 30_000),
    rate: { email: Number(env.NOTIFY_RATE_EMAIL ?? 2), telegram: Number(env.NOTIFY_RATE_TELEGRAM ?? 20), webhook: Number(env.NOTIFY_RATE_WEBHOOK ?? 10) },
  };
}
