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
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep trying until every read lands: a single failed read used to leave
    // the vault "loading" (and proposing disabled) until a page reload.
    const load = async (attempt: number) => {
      const [address, cfg] = await Promise.all([vaultAddress(owner).catch(() => null), getConfig().catch(() => null)]);
      if (off) return;
      if (!address || !cfg) {
        timer = setTimeout(() => void load(attempt + 1), Math.min(30_000, 3_000 * 2 ** attempt));
        return;
      }
      const list = cfg.erc20_tokens ?? [];
      const feePerTx = BigInt(cfg.eth_gas_limit) * BigInt(cfg.eth_max_fee_cap);
      setVault((v) => v ?? { address, balance: null, tokens: list.map((token) => ({ token, balance: null })), feePerTx });
      const [balance, toks] = await Promise.all([ethBalance(address).catch(() => null), tokenBalances(address, list)]);
      if (off) return;
      setVault({ address, balance, tokens: list.map((token, i) => ({ token, balance: toks[i] ?? null })), feePerTx });
      if (balance == null || toks.some((t) => t == null)) timer = setTimeout(() => void load(attempt + 1), Math.min(30_000, 3_000 * 2 ** attempt));
    };
    void load(0);
    return () => {
      off = true;
      clearTimeout(timer);
    };
  }, [owner]);
  return vault;
}
