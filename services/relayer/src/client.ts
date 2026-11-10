// Client helper: sign a Behest call as a NEP-366 delegate action and ask the
// relayer to submit it. The signer pays no gas.
import { actions, base64Encode, encodeSignedDelegate, teraToGas, type Account } from "near-api-js";

export async function sponsoredCall(
  signer: Account,
  relayerUrl: string,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
  tgas = 300,
): Promise<{ txHash: string }> {
  const { signedDelegate } = await signer.createSignedMetaTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)],
    blockHeightTtl: 120,
  });
  const res = await fetch(`${relayerUrl.replace(/\/$/, "")}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed_delegate: base64Encode(encodeSignedDelegate(signedDelegate)) }),
  });
  const body = (await res.json()) as { tx_hash?: string; code?: string; error?: string };
  if (!res.ok || !body.tx_hash) throw new Error(`relayer ${res.status} ${body.code ?? ""}: ${body.error ?? "unknown error"}`);
  return { txHash: body.tx_hash };
}

export interface RelayResult {
  tx_hash: string;
  status: "ok" | "failed";
  failure?: unknown;
  result?: unknown;
}

/** D23: submit an EVM-signed action (`personal_sign` of `message`) through the relayer's `evm_call`. */
export async function evmCall(relayerUrl: string, message: string, signature: string): Promise<RelayResult> {
  const res = await fetch(`${relayerUrl.replace(/\/$/, "")}/evm-call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  const body = (await res.json()) as Partial<RelayResult> & { code?: string; error?: string };
  if (!res.ok || !body.tx_hash) throw new Error(`relayer ${res.status} ${body.code ?? ""}: ${body.error ?? "unknown error"}`);
  return body as RelayResult;
}
