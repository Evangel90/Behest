import type { KeyPairString } from "near-api-js";
import { createBtcPort } from "./bitcoin.js";
import { Engine } from "./engine.js";
import { createEthPort } from "./eth.js";
import { createNearPort } from "./near.js";
import { fileStore } from "./store.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

const log = (msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const engine = new Engine(
  createNearPort({
    rpcUrl: env("NEAR_RPC_URL", "https://test.rpc.fastnear.com"),
    contractId: env("BEHEST_CONTRACT_ID"),
    executorAccountId: env("EXECUTOR_ACCOUNT_ID"),
    executorPrivateKey: env("EXECUTOR_PRIVATE_KEY") as KeyPairString,
  }),
  createEthPort(env("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")),
  fileStore(env("STATE_FILE", ".executor-state.json")),
  {
    confirmations: Number(env("CONFIRMATIONS", "6")),
    btcConfirmations: Number(env("BTC_CONFIRMATIONS", "1")),
    stuckAfterMs: Number(env("STUCK_AFTER_MS", "600000")),
    retryBackoffMs: Number(env("RETRY_BACKOFF_MS", "120000")),
    now: () => Date.now(),
    log,
  },
  createBtcPort(env("BTC_ESPLORA_URL", "https://blockstream.info/testnet4/api")),
);

const interval = Number(env("POLL_INTERVAL_MS", "15000"));
log("executor started", { interval });
for (;;) {
  try {
    const outcomes = await engine.tick();
    for (const [key, outcome] of outcomes) if (outcome !== "noop") log("outcome", { key, outcome });
  } catch (e) {
    log("tick failed", { error: String(e) });
  }
  await new Promise((r) => setTimeout(r, interval));
}
