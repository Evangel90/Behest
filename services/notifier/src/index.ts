// Behest notifier (MVP: console + optional webhook). Read-only: it holds no
// keys and can't affect plans. Watches every plan with an open release plus
// owners listed in NOTIFY_OWNERS (comma-separated) for check-in reminders.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";
import { notices, recipients, type Notice, type PlanView } from "./diff.js";

const contractId = process.env.BEHEST_CONTRACT_ID ?? "";
if (!contractId) throw new Error("missing env BEHEST_CONTRACT_ID");
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
const webhook = process.env.NOTIFY_WEBHOOK_URL;
const intervalMs = Number(process.env.NOTIFY_INTERVAL_MS ?? 30_000);
const statePath = process.env.NOTIFY_STATE_FILE ?? ".notifier-state.json";

interface State {
  owners: string[];
  sent: string[];
  last: Record<string, PlanView>;
}
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { owners: [], sent: [], last: {} };
const save = () => {
  state.sent = state.sent.slice(-5000);
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  renameSync(`${statePath}.tmp`, statePath);
};

const view = <T>(method: string, args: Record<string, unknown>) => provider.callFunction({ contractId, method, args }) as Promise<T>;

async function deliver(n: Notice, v: PlanView) {
  const to = recipients(v, n.to);
  console.log(JSON.stringify({ t: new Date().toISOString(), kind: n.kind, owner: n.owner, to, text: n.text }));
  if (!webhook) return;
  // Slack/Discord-compatible body plus structured fields.
  const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...n, content: n.text, recipients: to }) });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function tick() {
  const open = await view<string[]>("list_open_releases", { from_index: 0, limit: 100 });
  const listed = (process.env.NOTIFY_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const owners = [...new Set([...state.owners, ...open, ...listed])];
  state.owners = owners;
  for (const owner of owners) {
    const v = await view<PlanView | null>("get_plan", { owner }).catch(() => null);
    if (!v) continue;
    for (const n of notices(state.last[owner] ?? null, v)) {
      if (state.sent.includes(n.key)) continue;
      try {
        await deliver(n, v);
        state.sent.push(n.key);
      } catch (e) {
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "delivery failed; will retry", key: n.key, error: String(e) }));
      }
    }
    state.last[owner] = v;
  }
  save();
}

console.log(JSON.stringify({ msg: "notifier started", contractId, webhook: Boolean(webhook), intervalMs }));
for (;;) {
  await tick().catch((e) => console.error(JSON.stringify({ msg: "tick failed", error: String(e) })));
  await new Promise((r) => setTimeout(r, intervalMs));
}
