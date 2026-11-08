// Executor decision logic. Pure orchestration over NearPort/EthPort so it can
// be tested with fakes. The executor never decides recipients or amounts: it
// only broadcasts what the contract built and reports what it observes.
// Spec: docs/stage0/01-state-machine.md (T3–T6), 03-signing-boundary.md.

import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { expectedCall, isEvm, type EthPort, type NearPort, type Store, type Transfer } from "./types.js";

export interface EngineOptions {
  confirmations: number;
  stuckAfterMs: number;
  retryBackoffMs: number;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

/** Failure reasons the executor retries on its own. Others need a human. */
export const AUTO_RETRY = new Set(["SignFailed", "Stuck", "Underpriced", "FeeAboveCap", "Dropped", "BadSignature"]);

export type Outcome =
  | "noop"
  | "waiting-for-earlier-nonce"
  | "broadcast"
  | "confirmed"
  | "reported-failure"
  | "retried"
  | "rebroadcast"
  | "needs-human";

export class Engine {
  constructor(
    private near: NearPort,
    private eth: EthPort,
    private store: Store,
    private opts: EngineOptions,
  ) {}

  async tick(): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    const [owners, config] = await Promise.all([this.near.listOpenReleases(), this.near.config()]);
    for (const owner of owners) {
      const view = await this.near.getPlan(owner);
      const transfers = view?.plan.proposal?.transfers ?? [];
      const vault = transfers.some((t) => isEvm(t.asset)) ? await this.near.vaultAddress(owner) : null;
      for (const [index, t] of transfers.entries()) {
        if (!isEvm(t.asset) || !vault) continue;
        const key = `${owner}#${view!.plan.proposal!.id}#${index}`;
        try {
          out.set(key, await this.handle(owner, index, t, vault, BigInt(config.eth_max_fee_cap), config.eth_chain_id, key));
        } catch (e) {
          this.opts.log("transfer error", { key, error: String(e) });
        }
      }
    }
    return out;
  }

  async handle(
    owner: string,
    index: number,
    t: Transfer,
    vault: `0x${string}`,
    feeCap: bigint,
    chainId: number,
    key: string,
  ): Promise<Outcome> {
    switch (t.state) {
      case "Signed":
        return this.broadcast(owner, index, t, vault, feeCap, chainId, key);
      case "Broadcast":
        return this.track(owner, index, t, vault, key);
      case "Failed":
        return this.maybeRetry(owner, index, t, key);
      default:
        return "noop";
    }
  }

  private async broadcast(
    owner: string,
    index: number,
    t: Transfer,
    vault: `0x${string}`,
    feeCap: bigint,
    chainId: number,
    key: string,
  ): Promise<Outcome> {
    const raw = (await this.near.getSignedTx(owner, index)) as `0x${string}` | null;
    if (!raw) return "noop";

    // Defence in depth: the payload must be exactly the snapshot transfer and
    // signed by the plan's vault key.
    const tx = parseTransaction(raw);
    const sender = await recoverTransactionAddress({ serializedTransaction: raw as never });
    if (sender.toLowerCase() !== vault.toLowerCase()) {
      await this.near.reportFailed(owner, index, "BadSignature");
      return "reported-failure";
    }
    const want = expectedCall(t);
    if (tx.to?.toLowerCase() !== want.to || (tx.value ?? 0n) !== want.value || (tx.data ?? "0x").toLowerCase() !== want.data || tx.chainId !== chainId) {
      this.opts.log("payload mismatch: refusing to broadcast", { key });
      return "needs-human";
    }

    const nonce = tx.nonce ?? 0;
    const mined = await this.eth.minedNonce(vault);
    const mem = this.store.get(key);
    if (nonce > mined) return "waiting-for-earlier-nonce";
    if (nonce < mined) return this.reconcileConsumedNonce(owner, index, raw, key);

    // A mined revert still burns the vault's fee and its nonce, and then only
    // the admin can re-issue. So simulate before the first broadcast:
    // - it would revert (e.g. the vault holds less of a token than was
    //   reported): report WouldRevert and keep the nonce unused, so the heir can
    //   retry at the same nonce once the vault is topped up. No trust needed.
    // - it needs more gas than signed (since Glamsterdam a first transfer to an
    //   unused address costs far more than 21k): report GasLimitTooLow; a
    //   same-nonce re-sign after the admin raises the limit is safe.
    if (mem.hashes.length === 0) {
      const need = await this.eth.estimateTransferGas(vault, tx.to as `0x${string}`, tx.value ?? 0n, want.data as `0x${string}`).catch(() => null);
      if (need === "reverts") {
        this.opts.log("transfer would revert: refusing to broadcast", { key });
        await this.near.reportFailed(owner, index, "WouldRevert");
        return "reported-failure";
      }
      if (need !== null && need > (tx.gas ?? 0n)) {
        this.opts.log("gas limit too low: refusing to broadcast", { key, signed: String(tx.gas), needed: String(need) });
        await this.near.reportFailed(owner, index, "GasLimitTooLow");
        return "reported-failure";
      }
    }

    let hash: `0x${string}`;
    try {
      hash = await this.eth.sendRaw(raw);
    } catch (e) {
      const msg = String(e).toLowerCase();
      if (msg.includes("already known")) {
        hash = keccak256(raw);
      } else if (msg.includes("nonce too low")) {
        return this.reconcileConsumedNonce(owner, index, raw, key);
      } else if (msg.includes("underpriced") || msg.includes("fee cap") || msg.includes("base fee")) {
        const atCap = (tx.maxFeePerGas ?? 0n) >= feeCap;
        await this.near.reportFailed(owner, index, atCap ? "FeeAboveCap" : "Underpriced");
        return "reported-failure";
      } else {
        throw e;
      }
    }
    this.store.set(key, { ...mem, hashes: [...new Set([...mem.hashes, hash])], broadcastAt: this.opts.now() });
    await this.near.reportBroadcast(owner, index, hash);
    this.opts.log("broadcast", { key, hash, nonce });
    return "broadcast";
  }

  private async track(owner: string, index: number, t: Transfer, vault: `0x${string}`, key: string): Promise<Outcome> {
    const hash = t.tx_hash as `0x${string}`;
    const receipt = await this.eth.receipt(hash);
    if (receipt) {
      if (!receipt.success) {
        await this.near.reportFailed(owner, index, "Reverted");
        return "reported-failure";
      }
      const depth = (await this.eth.blockNumber()) - receipt.blockNumber + 1n;
      if (depth < BigInt(this.opts.confirmations)) return "noop";
      await this.near.reportConfirmed(owner, index, hash);
      this.opts.log("confirmed", { key, hash });
      return "confirmed";
    }

    const mem = this.store.get(key);
    if (mem.broadcastAt === undefined) {
      // First sighting by this executor (e.g. after a restart): start the clock now.
      this.store.set(key, { ...mem, broadcastAt: this.opts.now() });
      return "noop";
    }
    const since = this.opts.now() - mem.broadcastAt;
    if (await this.eth.known(hash)) {
      if (since < this.opts.stuckAfterMs) return "noop";
      await this.near.reportFailed(owner, index, "Stuck");
      return "reported-failure";
    }

    // Dropped from the mempool: if the nonce was used by another version of
    // this transfer, adopt it; otherwise re-send the same signed bytes.
    const raw = (await this.near.getSignedTx(owner, index)) as `0x${string}` | null;
    if (!raw) return "noop";
    const nonce = parseTransaction(raw).nonce ?? 0;
    if (nonce < (await this.eth.minedNonce(vault))) return this.reconcileConsumedNonce(owner, index, raw, key);
    try {
      await this.eth.sendRaw(raw);
    } catch (e) {
      if (!String(e).toLowerCase().includes("already known")) {
        await this.near.reportFailed(owner, index, "Dropped");
        return "reported-failure";
      }
    }
    this.store.set(key, { ...mem, broadcastAt: this.opts.now() });
    return "rebroadcast";
  }

  /**
   * The vault nonce is used. Only versions of this same transfer share it, so
   * find the one that landed. Candidates come from the contract, so this works
   * with an empty local store (restart, new machine, second executor).
   */
  private async reconcileConsumedNonce(owner: string, index: number, raw: `0x${string}`, key: string): Promise<Outcome> {
    const mem = this.store.get(key);
    const versions = (await this.near.getSignedTxVersions(owner, index)) as `0x${string}`[];
    const candidates = new Set([...versions.map((v) => keccak256(v)), ...mem.hashes, keccak256(raw)]);
    for (const h of candidates) {
      const r = await this.eth.receipt(h);
      if (r?.success) {
        await this.near.reportBroadcast(owner, index, h);
        this.store.set(key, { ...mem, hashes: [...new Set([...mem.hashes, h])], broadcastAt: this.opts.now() });
        return "broadcast";
      }
    }
    this.opts.log("nonce consumed by an unknown transaction: needs human review", { key });
    return "needs-human";
  }

  private async maybeRetry(owner: string, index: number, t: Transfer, key: string): Promise<Outcome> {
    if (!t.failure || !AUTO_RETRY.has(t.failure)) return "needs-human";
    const mem = this.store.get(key);
    if (mem.lastRetryAt && this.opts.now() - mem.lastRetryAt < this.opts.retryBackoffMs) return "noop";
    this.store.set(key, { ...mem, lastRetryAt: this.opts.now() });
    await this.near.retryTransfer(owner, index);
    this.opts.log("retry requested", { key, reason: t.failure });
    return "retried";
  }
}
