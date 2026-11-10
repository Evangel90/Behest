// Behest gas relayer.
//   POST /relay     {"signed_delegate": "<base64 borsh SignedDelegate>"}   NEP-366 meta-transaction
//   POST /evm-call  {"message", "signature"}                              D23 EVM-signed action → evm_call
//   GET  /evm-nonce?account=0x…                                           the actor's next nonce
//   GET  /health
// Both POSTs answer {tx_hash, status: "ok"|"failed", failure?, result?} once
// the transaction is included; policy refusals are 4xx {code, error}.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Account, JsonRpcProvider, actions, base64Decode, teraToGas, type KeyPairString } from "near-api-js";
import { Limiter, PolicyError, check, checkEvm, decode, holdsRole, type CallIntent } from "./policy.js";

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
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
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

const view = <T>(method: string, args: Record<string, unknown>) => provider.callFunction({ contractId, method, args }) as Promise<T>;

/** The sender must hold the method's role in the plan it names. */
async function authorize(intent: CallIntent) {
  const plan = (await view<Record<string, unknown> | null>("get_plan", { owner: intent.owner }).catch(() => null)) as Record<string, unknown> | null;
  if (plan && intent.role === "delay_signer") {
    const o = await view<{ delay_signers?: string[] } | null>("get_release_options", { owner: intent.owner }).catch(() => null);
    plan.delay_signers = o?.delay_signers ?? [];
  }
  if (!holdsRole(plan as never, intent)) throw new PolicyError("NO_ROLE", `${intent.sender} is not the ${intent.role} of ${intent.owner}`);
}

type Outcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

function summarize(outcome: Outcome) {
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  const failure = JSON.stringify(status).includes("Failure") ? status : undefined;
  let result: unknown;
  if (!failure && typeof status.SuccessValue === "string" && status.SuccessValue !== "") {
    try {
      result = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8"));
    } catch {
      result = undefined;
    }
  }
  return { tx_hash: outcome.transaction.hash as string, status: failure ? "failed" : "ok", failure, result };
}

async function relay(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as { signed_delegate?: string };
  if (!body.signed_delegate) throw new PolicyError("BAD_REQUEST", "signed_delegate is required");
  const bytes = base64Decode(body.signed_delegate);
  const sd = decode(bytes);
  const intent = check(sd, contractId);
  await authorize(intent);
  if (!limiter.take(intent.sender)) return send(res, 429, { code: "RATE_LIMITED", error: "too many sponsored calls; try later" });

  const outcome = await relayer.signAndSendTransaction({
    receiverId: intent.sender,
    actions: [actions.signedDelegate(sd as never)],
    throwOnFailure: false,
  });
  const out = summarize(outcome);
  log("relayed", { sender: intent.sender, method: intent.method, owner: intent.owner, txHash: out.tx_hash, failed: out.status === "failed" });
  send(res, 200, out);
}

async function evmCall(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as { message?: unknown; signature?: unknown };
  const intent = await checkEvm(body.message, body.signature, contractId);
  // Refuse a stale or future nonce before paying gas (the contract checks it again).
  const nonce = BigInt(await view<string>("get_evm_nonce", { account: intent.sender }));
  if (intent.nonce !== nonce) throw new PolicyError("EVM_NONCE", `expected nonce ${nonce}, got ${intent.nonce}`);
  await authorize(intent);
  if (!limiter.take(intent.sender)) return send(res, 429, { code: "RATE_LIMITED", error: "too many sponsored calls; try later" });

  const outcome = await relayer.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall("evm_call", { message: body.message, signature: body.signature }, teraToGas(300), 0n)],
    throwOnFailure: false,
  });
  const out = summarize(outcome);
  log("evm call", { sender: intent.sender, method: intent.method, owner: intent.owner, nonce: String(intent.nonce), txHash: out.tx_hash, failed: out.status === "failed" });
  send(res, 200, out);
}

async function evmNonce(url: URL, res: ServerResponse) {
  const account = (url.searchParams.get("account") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(account)) throw new PolicyError("BAD_REQUEST", "account must be a 0x address");
  const nonce = await view<string>("get_evm_nonce", { account });
  send(res, 200, { account, nonce: String(nonce) });
}

function fail(res: ServerResponse, e: unknown) {
  if (e instanceof PolicyError) return send(res, 400, { code: e.code, error: e.message });
  if (e instanceof SyntaxError) return send(res, 400, { code: "BAD_REQUEST", error: "invalid JSON" });
  log("relay error", { error: String(e) });
  send(res, 502, { code: "RELAY_FAILED", error: "could not submit the transaction" });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://relayer");
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, contractId, relayer: relayer.accountId });
  if (req.method === "GET" && url.pathname === "/evm-nonce") return void evmNonce(url, res).catch((e) => fail(res, e));
  if (req.method === "POST" && url.pathname === "/relay") return void relay(req, res).catch((e) => fail(res, e));
  if (req.method === "POST" && url.pathname === "/evm-call") return void evmCall(req, res).catch((e) => fail(res, e));
  send(res, 404, { code: "NOT_FOUND" });
}).listen(port, () => log("relayer listening", { port, contractId, relayer: relayer.accountId }));
