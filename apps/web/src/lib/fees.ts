"use client";
// D6 fee quotes: what a release's transfers will most likely cost right now,
// next to the worst case the contract reserves. The contract sets the fees
// itself (fixed priority fee and starting max fee on Sepolia, a starting fee
// rate on Bitcoin), so the only live inputs are Sepolia's base fee, a gas
// estimate per destination, and testnet4's going fee rate.
import { useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { BTC_ESPLORA } from "./config";
import { getConfig, sepoliaClient } from "./contract";
import { btcPayoutFees, ethTxCost } from "./plan";
import type { ContractConfig } from "./types";

export interface EthQuote {
  /** Likely total for these transactions at the current base fee. */
  total: bigint;
  /** Gas each transaction is expected to use (capped at the snapshot limit). */
  gas: bigint[];
  baseFee: bigint;
}

/** One vault transaction: plain ETH to `to`, or `token` sent to `to`. */
export interface EthTx {
  to: Hex;
  token?: Hex;
}

export function useEthQuote(cfg: ContractConfig | null, vault: Hex | null, txs: EthTx[]): EthQuote | null {
  const [q, setQ] = useState<EthQuote | null>(null);
  const key = txs.map((t) => `${t.to}:${t.token ?? ""}`).join(",");
  useEffect(() => {
    if (!cfg || !vault || !txs.length) return setQ(null);
    let off = false;
    (async () => {
      const limit = BigInt(cfg.eth_gas_limit);
      const block = await sepoliaClient.getBlock().catch(() => null);
      const baseFee = block?.baseFeePerGas ?? 0n;
      // A transfer to a never-used address costs far more than 21k since
      // Glamsterdam; estimating from the vault catches that. Fall back to the limit.
      const gas = await Promise.all(
        txs.map((t) =>
          sepoliaClient
            .estimateGas(
              t.token
                ? { account: vault, to: t.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [t.to, 1n] }) }
                : { account: vault, to: t.to, value: 1n },
            )
            .then((g) => (g < limit ? g : limit))
            .catch(() => limit),
        ),
      );
      const total = gas.reduce((a, g) => a + ethTxCost(g, baseFee, cfg), 0n);
      if (!off) setQ({ total, gas, baseFee });
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, vault, key]);
  return q;
}

export interface BtcQuote {
  /** Fees at the contract's starting rate. */
  likely: bigint;
  feeRate: number;
  /** testnet4's rate for confirmation within ~6 blocks, if known. */
  networkRate: number | null;
  /** The network wants more than the starting rate: expect a fee bump (still within the reserve). */
  bumpLikely: boolean;
}

export function useBtcQuote(cfg: ContractConfig | null, heirs: number, inputs: number): BtcQuote | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`${BTC_ESPLORA}/fee-estimates`)
      .then((r) => r.json() as Promise<Record<string, number>>)
      .then((e) => !off && setRate(e["6"] ?? e["144"] ?? null))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);
  if (!cfg?.btc || heirs === 0 || inputs === 0) return null;
  const feeRate = cfg.btc.fee_rate;
  return { likely: btcPayoutFees({ heirs, inputs, feeRate }), feeRate, networkRate: rate, bumpLikely: rate != null && rate > feeRate };
}

/** The contract's config, read once per mount. */
export function useConfig(): ContractConfig | null {
  const [cfg, setCfg] = useState<ContractConfig | null>(null);
  useEffect(() => void getConfig().then(setCfg).catch(() => {}), []);
  return cfg;
}
