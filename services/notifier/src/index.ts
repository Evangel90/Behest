// Behest notifier. Read-only towards the chain: it holds no NEAR keys, only
// calls view methods, and nothing it does (or fails to do) can change a plan.
// Watches plans, turns changes into notices (diff.ts), and delivers them per
// person over email, Telegram and webhooks (engine.ts), with contacts kept
// private in a local SQLite database and managed through a signed HTTP API.
import { JsonRpcProvider } from "near-api-js";
import { createApi } from "./api.js";
import { parseKey, type HeirRecord } from "./records.js";
import { councilReader } from "./council.js";
import { EmailSender } from "./channels/email.js";
import { TelegramBot } from "./channels/telegram.js";
import { WebhookSender } from "./channels/webhook.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Engine } from "./engine.js";
import { rpcKeyLookup } from "./nep413.js";
import { Watcher } from "./watcher.js";

const cfg = loadConfig();
const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const store = new Store(cfg.dbPath);
const imported = store.importLegacy(cfg.legacyStatePath);
if (imported) log("imported legacy state file", { sent: imported, from: cfg.legacyStatePath });

const provider = new JsonRpcProvider({ url: cfg.nearRpcUrl });
const view = <T>(method: string, args: Record<string, unknown>) => provider.callFunction({ contractId: cfg.contractId, method, args }) as Promise<T>;
const councilOf = councilReader(<T>(contractId: string, method: string, args: Record<string, unknown>) => provider.callFunction({ contractId, method, args }) as Promise<T>);

const email = cfg.smtp ? new EmailSender(cfg.smtp) : undefined;
const telegram = cfg.telegram ? new TelegramBot(cfg.telegram, store, log) : undefined;
const webhook = new WebhookSender(cfg.contractId, cfg.webhookAllowInsecure);
const engine = new Engine(store, cfg, { email, telegram, webhook }, log);
const watcher = new Watcher(store, engine, view, { owners: cfg.owners, appUrl: cfg.appUrl, contractId: cfg.contractId, councilOf }, log);
if (telegram) telegram.onLinked = (account, id, who) => engine.security(account, "Telegram linked", `Telegram ${who} now receives the notifications for ${account}. If you didn't do this, remove it in Behest.`, id);

const recordsKey = parseKey(process.env.NOTIFY_RECORDS_KEY);
const records = recordsKey
  ? {
      key: recordsKey,
      chain: {
        commitments: async (owner: string) => (await view<{ commitments: string[] } | null>("get_private_heirs", { owner }))?.commitments ?? null,
        commitmentOf: (owner: string, record: HeirRecord) => view<string>("get_heir_commitment", { owner, record }),
        overdue: async (owner: string) => {
          const p = await view<{ now_ms: number; overdue_at_ms: number } | null>("get_plan", { owner });
          return !!p && p.now_ms >= p.overdue_at_ms;
        },
      },
    }
  : undefined;
const api = createApi({ store, engine, cfg, keys: rpcKeyLookup(cfg.nearRpcUrl), email, telegram, isMember: (o, a) => watcher.isMember(o, a), councilOf, log, records });
api.listen(cfg.port, cfg.host, () => log("notifier api listening", { port: cfg.port, publicUrl: cfg.publicUrl }));

log("notifier started", {
  contractId: cfg.contractId,
  rpc: cfg.nearRpcUrl,
  intervalMs: cfg.intervalMs,
  db: cfg.dbPath,
  channels: { email: Boolean(email), telegram: telegram ? cfg.telegram!.username : false, webhook: true, operatorFeed: Boolean(cfg.operatorWebhookUrl) },
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    telegram?.stop();
    api.close();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 200);
  });
}

if (telegram) void telegram.poll();

// Delivery runs on its own short loop so retries and rate limits don't wait for the chain poll.
void (async () => {
  while (!stopping) {
    await engine.dispatch().catch((e) => log("dispatch failed", { error: String(e) }));
    await new Promise((r) => setTimeout(r, 1000));
  }
})();

let lastPrune = 0;
while (!stopping) {
  const started = Date.now();
  await watcher
    .tick()
    .then((r) => r.notices && log("tick", r))
    .catch((e) => log("tick failed", { error: String(e) }));
  if (Date.now() - lastPrune > 3_600_000) {
    store.prune();
    lastPrune = Date.now();
  }
  await new Promise((r) => setTimeout(r, Math.max(1000, cfg.intervalMs - (Date.now() - started))));
}
