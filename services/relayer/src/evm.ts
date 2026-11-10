// D23 signed actions: the text an EVM wallet signs with `personal_sign` for
// the Behest contract's `evm_call`. Shared by the relayer, the testnet tools
// and the web app. The contract is the authority; this mirrors its checks so
// the relayer refuses what the contract would refuse before paying gas.
//
//   Behest signed action
//   <summary for the human; not checked>
//
//   {"contract":"behest.testnet","network":"testnet","actor":"0x…","method":"claim","args":{…},"nonce":"0","deadline_ms":"…"}

export const EVM_HEADER = "Behest signed action";
export const MAX_MESSAGE_BYTES = 8 * 1024;

export interface SignedAction {
  contract: string;
  network: "testnet" | "mainnet";
  /** `0x` + 40 lowercase hex: the signer's eth-implicit NEAR account. */
  actor: string;
  method: string;
  args: Record<string, unknown>;
  /** Decimal u64: the actor's `get_evm_nonce`. */
  nonce: string;
  /** Decimal ms timestamp; the contract refuses the action after it. */
  deadline_ms: string;
}

const FIELDS = ["contract", "network", "actor", "method", "args", "nonce", "deadline_ms"] as const;

export class SignedActionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** "mainnet" for `.near` contracts, else "testnet" (as the contract derives it). */
export function networkOf(contractId: string): "testnet" | "mainnet" {
  return contractId.endsWith(".near") ? "mainnet" : "testnet";
}

/** The exact text to sign. Field order is fixed so the wallet shows a stable layout. */
export function signedActionMessage(summary: string, a: SignedAction): string {
  if (/[\r\n]/.test(summary)) throw new Error("summary must be one line");
  const ordered = Object.fromEntries(FIELDS.map((k) => [k, a[k]]));
  return `${EVM_HEADER}\n${summary}\n\n${JSON.stringify(ordered)}`;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Parses a signed-action message with the contract's rules (header, one summary line, strict JSON). */
export function parseSignedAction(message: string): { summary: string; action: SignedAction } {
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) throw new SignedActionError("EVM_MESSAGE", "message too long");
  const prefix = `${EVM_HEADER}\n`;
  if (!message.startsWith(prefix)) throw new SignedActionError("EVM_MESSAGE", `message must start with "${EVM_HEADER}"`);
  const rest = message.slice(prefix.length);
  const cut = rest.indexOf("\n\n");
  if (cut < 0) throw new SignedActionError("EVM_MESSAGE", "missing blank line before the JSON");
  const summary = rest.slice(0, cut);
  if (/[\r\n]/.test(summary)) throw new SignedActionError("EVM_MESSAGE", "summary must be one line");
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(rest.slice(cut + 2)) as Record<string, unknown>;
  } catch {
    throw new SignedActionError("EVM_MESSAGE", "action JSON is invalid");
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new SignedActionError("EVM_MESSAGE", "action must be a JSON object");
  const keys = Object.keys(a);
  if (keys.length !== FIELDS.length || !FIELDS.every((f) => keys.includes(f))) throw new SignedActionError("EVM_MESSAGE", `action must have exactly ${FIELDS.join(", ")}`);
  for (const f of ["contract", "network", "actor", "method", "nonce", "deadline_ms"] as const) {
    if (typeof a[f] !== "string") throw new SignedActionError("EVM_MESSAGE", `${f} must be a string`);
  }
  if (!a.args || typeof a.args !== "object" || Array.isArray(a.args)) throw new SignedActionError("EVM_ARGS", "args must be a JSON object");
  if (!DECIMAL.test(a.nonce as string) || !DECIMAL.test(a.deadline_ms as string)) throw new SignedActionError("EVM_MESSAGE", "nonce and deadline_ms must be decimal strings");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.actor as string)) throw new SignedActionError("EVM_ACTOR", "actor must be a 0x address");
  return { summary, action: a as unknown as SignedAction };
}

const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** 65-byte `0x` r‖s‖v with v in 27/28/0/1, nonzero r < n and low s (what the contract accepts). */
export function isCanonicalSignature(sig: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const r = BigInt(`0x${sig.slice(2, 66)}`);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  return [0, 1, 27, 28].includes(v) && r > 0n && r < N && s > 0n && s <= HALF_N;
}
