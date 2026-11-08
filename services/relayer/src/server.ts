// Behest gas relayer. POST /relay {"signed_delegate": "<base64 borsh SignedDelegate>"}
// → {"tx_hash"} once the meta-transaction is included. GET /health for status.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Account, JsonRpcProvider, actions, base64Decode, type KeyPairString } from "near-api-js";
import { Limiter, PolicyError, check, decode, holdsRole } from "./policy.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

const contractId = env("BEHEST_CONTRACT_ID");
const provider = new JsonRpcProvider({ url: env("NEAR_RPC_URL", "https://test.rpc.fastnear.com") });
const relayer = new Account(env("RELAYER_ACCOUNT_ID"), provider, env("RELAYER_PRIVATE_KEY") as KeyPairString);
const limiter = new Limiter(Number(env("RELAYER_PER_SENDER_PER_HOUR", "30")), Number(env("RELAYER_GLOBAL_PER_DAY", "2000")));
const origin = env("RELAYER_ALLOWED_ORIGIN", "*");
const port = Number(env("RELAYER_PORT", "8787"));

const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new PolicyError("TOO_LARGE", "request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function relay(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as { signed_delegate?: string };
  if (!body.signed_delegate) throw new PolicyError("BAD_REQUEST", "signed_delegate is required");
  const bytes = base64Decode(body.signed_delegate);
  const sd = decode(bytes);
  const intent = check(sd, contractId);

  const plan = (await provider.callFunction({ contractId, method: "get_plan", args: { owner: intent.owner } }).catch(() => null)) as Record<string, unknown> | null;
  if (plan && intent.role === "delay_signer") {
    const o = (await provider.callFunction({ contractId, method: "get_release_options", args: { owner: intent.owner } }).catch(() => null)) as { delay_signers?: string[] } | null;
    plan.delay_signers = o?.delay_signers ?? [];
  }
  if (!holdsRole(plan as never, intent)) throw new PolicyError("NO_ROLE", `${intent.sender} is not the ${intent.role} of ${intent.owner}`);
  if (!limiter.take(intent.sender)) return send(res, 429, { code: "RATE_LIMITED", error: "too many sponsored calls; try later" });

  const outcome = await relayer.signAndSendTransaction({
    receiverId: intent.sender,
    actions: [actions.signedDelegate(sd as never)],
    throwOnFailure: false,
  });
  const txHash = outcome.transaction.hash as string;
  const failure = JSON.stringify(outcome.status).includes("Failure") ? outcome.status : undefined;
  log("relayed", { sender: intent.sender, method: intent.method, owner: intent.owner, txHash, failed: Boolean(failure) });
  send(res, 200, { tx_hash: txHash, status: failure ? "failed" : "ok", failure });
}

createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, contractId, relayer: relayer.accountId });
  if (req.method !== "POST" || req.url !== "/relay") return send(res, 404, { code: "NOT_FOUND" });
  relay(req, res).catch((e) => {
    if (e instanceof PolicyError) return send(res, 400, { code: e.code, error: e.message });
    if (e instanceof SyntaxError) return send(res, 400, { code: "BAD_REQUEST", error: "invalid JSON" });
    log("relay error", { error: String(e) });
    send(res, 502, { code: "RELAY_FAILED", error: "could not submit the transaction" });
  });
}).listen(port, () => log("relayer listening", { port, contractId, relayer: relayer.accountId }));
