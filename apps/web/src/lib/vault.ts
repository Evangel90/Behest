"use client";
// The plan's Sepolia vault: address, ETH and allowlisted token balances.
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { ethBalance, getConfig, tokenBalances, vaultAddress } from "./contract";
import type { Erc20Token } from "./types";

export interface Vault {
  address: Hex;
  balance: bigint | null;
  /** Allowlisted tokens with their vault balance (null while unread or on error). */
  tokens: { token: Erc20Token; balance: bigint | null }[];
  /** Most a single vault transaction can cost (gas limit × fee cap). */
  feePerTx: bigint | null;
}

export function useVault(owner: string) {
  const [vault, setVault] = useState<Vault | null>(null);
  useEffect(() => {
    let off = false;
    (async () => {
      const [address, cfg] = await Promise.all([vaultAddress(owner).catch(() => null), getConfig().catch(() => null)]);
      if (!address || off) return;
      const list = cfg?.erc20_tokens ?? [];
      const feePerTx = cfg ? BigInt(cfg.eth_gas_limit) * BigInt(cfg.eth_max_fee_cap) : null;
      setVault({ address, balance: null, tokens: list.map((token) => ({ token, balance: null })), feePerTx });
      const [balance, toks] = await Promise.all([ethBalance(address).catch(() => null), tokenBalances(address, list)]);
      if (!off) setVault({ address, balance, tokens: list.map((token, i) => ({ token, balance: toks[i] ?? null })), feePerTx });
    })();
    return () => {
      off = true;
    };
  }, [owner]);
  return vault;
}
