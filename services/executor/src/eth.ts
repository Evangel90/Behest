import { BaseError, ExecutionRevertedError, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { EthPort } from "./types.js";

export function createEthPort(rpcUrl: string): EthPort {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  return {
    sendRaw: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { blockNumber: r.blockNumber, success: r.status === "success" };
      } catch {
        return null;
      }
    },
    async known(hash) {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch {
        return false;
      }
    },
    blockNumber: () => client.getBlockNumber(),
    minedNonce: (address) => client.getTransactionCount({ address, blockTag: "latest" }),
    async estimateTransferGas(from, to, value, data) {
      try {
        return await client.estimateGas({ account: from, to, value, data: data && data !== "0x" ? data : undefined });
      } catch (e) {
        if (e instanceof BaseError && e.walk((x) => x instanceof ExecutionRevertedError)) return "reverts";
        throw e;
      }
    },
  };
}
