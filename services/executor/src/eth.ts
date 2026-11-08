import { createPublicClient, http } from "viem";
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
    estimateTransferGas: (from, to, value) => client.estimateGas({ account: from, to, value }),
  };
}
