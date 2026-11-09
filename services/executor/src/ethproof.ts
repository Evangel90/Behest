// D22: builds the proof that a Sepolia transaction succeeded or reverted:
// the block header (RLP), the transaction's index, and Merkle-Patricia
// proofs of the transaction and its receipt. The contract checks the proofs
// and asks the Ethereum light client on NEAR for the header's hash, so the
// outcome no longer rests on an executor's or admin's word.
import { RLP } from "@ethereumjs/rlp";
import { Trie } from "@ethereumjs/trie";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";

export interface EthOutcomeProof {
  header: Hex;
  tx_index: number;
  tx_proof: Hex[];
  receipt_proof: Hex[];
}

/** JSON-RPC access the builder needs (any Sepolia node). */
export interface ProofRpc {
  request(method: string, params: unknown[]): Promise<any>;
}

export function httpRpc(url: string): ProofRpc {
  let id = 0;
  return {
    async request(method, params) {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    },
  };
}

const q = (v: string | undefined | null): Uint8Array => {
  // RLP integer: big-endian without leading zeros (0 is the empty string)
  if (!v) return new Uint8Array();
  const n = BigInt(v);
  if (n === 0n) return new Uint8Array();
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return hexToBytes(`0x${h}`);
};
const b = (v: string) => hexToBytes(v as Hex);

/**
 * The header's RLP. Field order is fixed by the forks; the newest fields
 * (block access list hash, slot number) are tried in both orders and the
 * encoding whose hash equals the block's is used.
 */
export function encodeHeader(blk: Record<string, any>): Hex {
  const base: Uint8Array[] = [
    b(blk.parentHash), b(blk.sha3Uncles), b(blk.miner), b(blk.stateRoot), b(blk.transactionsRoot), b(blk.receiptsRoot), b(blk.logsBloom),
    q(blk.difficulty), q(blk.number), q(blk.gasLimit), q(blk.gasUsed), q(blk.timestamp), b(blk.extraData), b(blk.mixHash), b(blk.nonce),
  ];
  const opt: [string, (v: string) => Uint8Array][] = [
    ["baseFeePerGas", q], ["withdrawalsRoot", b], ["blobGasUsed", q], ["excessBlobGas", q], ["parentBeaconBlockRoot", b], ["requestsHash", b],
  ];
  const fields = [...base];
  for (const [k, enc] of opt) if (blk[k] != null) fields.push(enc(blk[k]));
  const tails: [string, (v: string) => Uint8Array][][] = [
    [["blockAccessListHash", b], ["slotNumber", q]],
    [["slotNumber", q], ["blockAccessListHash", b]],
  ];
  for (const tail of tails) {
    const f = [...fields];
    for (const [k, enc] of tail) if (blk[k] != null) f.push(enc(blk[k]));
    const raw = bytesToHex(RLP.encode(f));
    if (keccak256(raw) === blk.hash) return raw;
  }
  throw new Error(`can't reproduce the header of block ${blk.number}: unknown fields`);
}

/** Receipt as stored in the receipts trie (EIP-2718 typed envelope). */
export function encodeReceipt(r: Record<string, any>): Uint8Array {
  const body = RLP.encode([
    q(r.status),
    q(r.cumulativeGasUsed),
    b(r.logsBloom),
    (r.logs as any[]).map((l) => [b(l.address), (l.topics as string[]).map(b), b(l.data)]),
  ]);
  const type = Number(r.type ?? "0x0");
  return type === 0 ? body : new Uint8Array([type, ...body]);
}

const key = (i: number) => RLP.encode(i);

async function trieOf(values: Uint8Array[]): Promise<Trie> {
  const t = new Trie();
  for (let i = 0; i < values.length; i++) await t.put(key(i), values[i]!);
  return t;
}

/** Builds the proof for `txHash` from a Sepolia node. */
export async function buildOutcomeProof(rpc: ProofRpc, txHash: Hex): Promise<EthOutcomeProof & { block_number: number; success: boolean }> {
  const rcpt = await rpc.request("eth_getTransactionReceipt", [txHash]);
  if (!rcpt) throw new Error("transaction not mined");
  const blk = await rpc.request("eth_getBlockByNumber", [rcpt.blockNumber, false]);
  const header = encodeHeader(blk);
  const n = (blk.transactions as string[]).length;
  const raws: Uint8Array[] = await Promise.all(
    Array.from({ length: n }, (_, i) => rpc.request("eth_getRawTransactionByBlockNumberAndIndex", [rcpt.blockNumber, `0x${i.toString(16)}`]).then(b)),
  );
  const receipts = (await rpc.request("eth_getBlockReceipts", [rcpt.blockNumber])) as Record<string, any>[];
  const txTrie = await trieOf(raws);
  const rTrie = await trieOf(receipts.map(encodeReceipt));
  if (bytesToHex(txTrie.root()) !== blk.transactionsRoot) throw new Error("transactions root mismatch");
  if (bytesToHex(rTrie.root()) !== blk.receiptsRoot) throw new Error("receipts root mismatch");
  const index = Number(rcpt.transactionIndex);
  if (keccak256(raws[index]!) !== txHash) throw new Error("index does not hold the transaction");
  const tx_proof = (await txTrie.createProof(key(index))).map((p) => bytesToHex(p));
  const receipt_proof = (await rTrie.createProof(key(index))).map((p) => bytesToHex(p));
  return { header, tx_index: index, tx_proof, receipt_proof, block_number: Number(rcpt.blockNumber), success: rcpt.status === "0x1" };
}
