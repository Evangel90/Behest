import { baseEncode } from "near-api-js";
import { encodeFunctionData, erc20Abi, hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, type Outcome } from "../src/engine.js";
import { ethAddressFromMpcKey } from "../src/near.js";
import { memoryStore } from "../src/store.js";
import type { EthPort, NearPort, PlanView, Receipt, Store, Transfer } from "../src/types.js";

const vaultKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const strangerKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const HEIR = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const GWEI = 1_000_000_000n;
const CAP = 50n * GWEI;
const OWNER = "owner.testnet";

async function signed(opts: { nonce?: number; to?: Hex; value?: bigint; data?: Hex; maxFee?: bigint; chainId?: number; signer?: typeof vaultKey } = {}) {
  return (opts.signer ?? vaultKey).signTransaction({
    type: "eip1559",
    chainId: opts.chainId ?? 11155111,
    nonce: opts.nonce ?? 0,
    to: opts.to ?? HEIR,
    value: opts.value ?? 1000n,
    data: opts.data,
    gas: 21000n,
    maxFeePerGas: opts.maxFee ?? 20n * GWEI,
    maxPriorityFeePerGas: 2n * GWEI,
  });
}

function transfer(state: Transfer["state"], extra: Partial<Transfer> = {}): Transfer {
  return {
    heir: "amara.testnet",
    asset: "Eth",
    destination: HEIR,
    amount: "1000",
    state,
    eth_tx: null,
    signature: null,
    attempts: 1,
    tx_hash: null,
    failure: null,
    ...extra,
  };
}

class FakeNear implements NearPort {
  transfers: Transfer[] = [];
  raw: Hex | null = null;
  versions: Hex[] = [];
  calls: string[] = [];
  config = async () => ({ eth_max_fee_cap: CAP.toString(), eth_chain_id: 11155111, mpc_contract: "v1.signer-prod.testnet" });
  listOpenReleases = async () => [OWNER];
  getPlan = async (): Promise<PlanView> => ({ plan: { owner: OWNER, version: 1, proposal: { id: 1, transfers: this.transfers } }, status: "Executing" });
  getSignedTx = async () => this.raw;
  getSignedTxVersions = async () => this.versions;
  vaultAddress = async () => vaultKey.address;
  reportBroadcast = async (_o: string, i: number, h: string) => void this.calls.push(`broadcast:${i}:${h}`);
  reportConfirmed = async (_o: string, i: number, h: string) => void this.calls.push(`confirmed:${i}:${h}`);
  reportFailed = async (_o: string, i: number, r: string) => void this.calls.push(`failed:${i}:${r}`);
  retryTransfer = async (_o: string, i: number) => void this.calls.push(`retry:${i}`);
}

class FakeEth implements EthPort {
  mined = 0;
  head = 100n;
  sent: Hex[] = [];
  sendError: string | null = null;
  receipts = new Map<string, Receipt>();
  mempool = new Set<string>();
  sendRaw = async (raw: Hex) => {
    if (this.sendError) throw new Error(this.sendError);
    this.sent.push(raw);
    const h = keccak256(raw);
    this.mempool.add(h);
    return h;
  };
  receipt = async (h: Hex) => this.receipts.get(h) ?? null;
  known = async (h: Hex) => this.mempool.has(h) || this.receipts.has(h);
  blockNumber = async () => this.head;
  minedNonce = async () => this.mined;
  needGas: bigint | "reverts" = 21_000n;
  estimateTransferGas = async () => this.needGas;
}

let near: FakeNear, eth: FakeEth, store: Store, clock: number, engine: Engine;

async function run(): Promise<Outcome | undefined> {
  return (await engine.tick()).get(`${OWNER}#1#0`);
}

beforeEach(() => {
  near = new FakeNear();
  eth = new FakeEth();
  store = memoryStore();
  clock = 1_000_000;
  engine = new Engine(near, eth, store, {
    confirmations: 6,
    stuckAfterMs: 600_000,
    retryBackoffMs: 120_000,
    now: () => clock,
    log: () => {},
  });
});

describe("Signed transfers", () => {
  it("broadcasts the contract-signed bytes and reports the hash", async () => {
    near.raw = await signed();
    near.transfers = [transfer("Signed")];
    expect(await run()).toBe("broadcast");
    expect(eth.sent).toEqual([near.raw]);
    expect(near.calls).toEqual([`broadcast:0:${keccak256(near.raw)}`]);
  });

  it("rejects a signature that is not from the plan vault", async () => {
    near.raw = await signed({ signer: strangerKey });
    near.transfers = [transfer("Signed")];
    expect(await run()).toBe("reported-failure");
    expect(eth.sent).toEqual([]);
    expect(near.calls).toEqual(["failed:0:BadSignature"]);
  });

  it("refuses to broadcast a payload that differs from the snapshot", async () => {
    near.raw = await signed({ value: 999_999n });
    near.transfers = [transfer("Signed")];
    expect(await run()).toBe("needs-human");
    expect(eth.sent).toEqual([]);
    expect(near.calls).toEqual([]);
  });

  it.each([
    ["recipient", { to: "0x000000000000000000000000000000000000dEaD" as Hex }],
    ["chain", { chainId: 1 }],
  ])("refuses a signed tx whose %s differs from the snapshot", async (_k, opts) => {
    near.raw = await signed(opts);
    near.transfers = [transfer("Signed")];
    expect(await run()).toBe("needs-human");
    expect(eth.sent).toEqual([]);
  });

  describe("ERC-20", () => {
    const TOKEN = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as Hex;
    const call = (to: Hex, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
    const tokenTransfer = () => transfer("Signed", { asset: { Erc20: TOKEN } });

    it("broadcasts a token transfer whose calldata matches the snapshot", async () => {
      near.raw = await signed({ to: TOKEN, value: 0n, data: call(HEIR as Hex, 1000n) });
      near.transfers = [tokenTransfer()];
      expect(await run()).toBe("broadcast");
      expect(eth.sent).toEqual([near.raw]);
    });

    it.each([
      ["recipient in calldata", { to: TOKEN, value: 0n, data: call("0x000000000000000000000000000000000000dEaD", 1000n) }],
      ["amount in calldata", { to: TOKEN, value: 0n, data: call(HEIR as Hex, 1001n) }],
      ["token contract", { to: "0x000000000000000000000000000000000000dEaD" as Hex, value: 0n, data: call(HEIR as Hex, 1000n) }],
      ["attached ETH value", { to: TOKEN, value: 1n, data: call(HEIR as Hex, 1000n) }],
      ["a plain ETH transfer", { to: HEIR as Hex, value: 1000n }],
    ])("refuses a token tx with a different %s", async (_k, opts) => {
      near.raw = await signed(opts);
      near.transfers = [tokenTransfer()];
      expect(await run()).toBe("needs-human");
      expect(eth.sent).toEqual([]);
    });
  });

  it("reports WouldRevert without broadcasting, keeping the nonce for a same-nonce retry", async () => {
    near.raw = await signed();
    near.transfers = [transfer("Signed")];
    eth.needGas = "reverts"; // e.g. the vault holds less of the token than was reported
    expect(await run()).toBe("reported-failure");
    expect(eth.sent).toEqual([]);
    expect(near.calls).toEqual(["failed:0:WouldRevert"]);
  });

  it("does not auto-retry WouldRevert (someone has to top up the vault first)", async () => {
    near.transfers = [transfer("Failed", { failure: "WouldRevert" })];
    expect(await run()).toBe("needs-human");
    expect(near.calls).toEqual([]);
  });

  it("refuses to broadcast when the signed gas limit is below the estimate", async () => {
    near.raw = await signed();
    near.transfers = [transfer("Signed")];
    eth.needGas = 207_391n; // first transfer to an unused address on Sepolia
    expect(await run()).toBe("reported-failure");
    expect(eth.sent).toEqual([]);
    expect(near.calls).toEqual(["failed:0:GasLimitTooLow"]);
  });

  it("does not auto-retry GasLimitTooLow (needs the admin to raise the limit)", async () => {
    near.transfers = [transfer("Failed", { failure: "GasLimitTooLow" })];
    expect(await run()).toBe("needs-human");
    expect(near.calls).toEqual([]);
  });

  it("waits while an earlier vault nonce is unmined", async () => {
    near.raw = await signed({ nonce: 1 });
    near.transfers = [transfer("Signed")];
    expect(await run()).toBe("waiting-for-earlier-nonce");
    expect(eth.sent).toEqual([]);
  });

  it("reports Underpriced below the cap and FeeAboveCap at the cap", async () => {
    near.transfers = [transfer("Signed")];
    eth.sendError = "replacement transaction underpriced";
    near.raw = await signed({ maxFee: 20n * GWEI });
    await run();
    near.raw = await signed({ maxFee: CAP });
    await run();
    expect(near.calls).toEqual(["failed:0:Underpriced", "failed:0:FeeAboveCap"]);
  });

  it("treats 'already known' as a successful broadcast", async () => {
    near.raw = await signed();
    near.transfers = [transfer("Signed")];
    eth.sendError = "already known";
    expect(await run()).toBe("broadcast");
    expect(near.calls).toEqual([`broadcast:0:${keccak256(near.raw)}`]);
  });
});

describe("Broadcast transfers", () => {
  async function broadcastFirst() {
    near.raw = await signed();
    near.transfers = [transfer("Signed")];
    await run();
    const hash = keccak256(near.raw);
    near.transfers = [transfer("Broadcast", { tx_hash: hash })];
    near.calls = [];
    return hash;
  }

  it("confirms only after the required depth", async () => {
    const hash = await broadcastFirst();
    eth.receipts.set(hash, { blockNumber: 98n, success: true });
    expect(await run()).toBe("noop");
    eth.head = 103n;
    expect(await run()).toBe("confirmed");
    expect(near.calls).toEqual([`confirmed:0:${hash}`]);
  });

  it("reports a reverted transaction", async () => {
    const hash = await broadcastFirst();
    eth.receipts.set(hash, { blockNumber: 50n, success: false });
    expect(await run()).toBe("reported-failure");
    expect(near.calls).toEqual(["failed:0:Reverted"]);
  });

  it("reports Stuck after the timeout while still pending", async () => {
    await broadcastFirst();
    expect(await run()).toBe("noop");
    clock += 600_001;
    expect(await run()).toBe("reported-failure");
    expect(near.calls).toEqual(["failed:0:Stuck"]);
  });

  it("rebroadcasts the same bytes when dropped from the mempool", async () => {
    await broadcastFirst();
    eth.mempool.clear();
    expect(await run()).toBe("rebroadcast");
    expect(eth.sent).toEqual([near.raw, near.raw]);
    expect(near.calls).toEqual([]);
  });

  it("finds the mined version from contract state with an empty local store", async () => {
    // Version 1 was broadcast by some other executor; this one has no memory.
    const v1 = await signed();
    const v2 = await signed({ maxFee: 30n * GWEI });
    near.raw = v2;
    near.versions = [v1, v2];
    near.transfers = [transfer("Signed")];
    eth.mined = 1;
    eth.receipts.set(keccak256(v1), { blockNumber: 90n, success: true });
    expect(await run()).toBe("broadcast");
    expect(near.calls).toEqual([`broadcast:0:${keccak256(v1)}`]);
    expect(eth.sent).toEqual([]);
  });

  it("starts the stuck timer on first sighting after a restart", async () => {
    const raw = await signed();
    const hash = keccak256(raw);
    near.raw = raw;
    eth.mempool.add(hash);
    near.transfers = [transfer("Broadcast", { tx_hash: hash })];
    expect(await run()).toBe("noop");
    clock += 600_001;
    expect(await run()).toBe("reported-failure");
    expect(near.calls).toEqual(["failed:0:Stuck"]);
  });

  it("adopts an earlier fee version of the same transfer that was mined", async () => {
    const first = await broadcastFirst();
    // A fee-bumped re-sign exists, but version 1 was mined at that nonce.
    near.raw = await signed({ maxFee: 30n * GWEI });
    near.transfers = [transfer("Signed")];
    eth.mined = 1;
    eth.receipts.set(first, { blockNumber: 90n, success: true });
    expect(await run()).toBe("broadcast");
    expect(near.calls).toEqual([`broadcast:0:${first}`]);
    expect(eth.sent).toHaveLength(1);
  });
});

describe("Failed transfers", () => {
  it("retries recoverable failures with backoff", async () => {
    near.transfers = [transfer("Failed", { failure: "SignFailed" })];
    expect(await run()).toBe("retried");
    expect(await run()).toBe("noop");
    clock += 120_001;
    expect(await run()).toBe("retried");
    expect(near.calls).toEqual(["retry:0", "retry:0"]);
  });

  it("escalates failures that need a human", async () => {
    near.transfers = [transfer("Failed", { failure: "Reverted" })];
    expect(await run()).toBe("needs-human");
    expect(near.calls).toEqual([]);
  });

  it("ignores NEAR transfers and in-flight states", async () => {
    near.transfers = [transfer("Signing"), { ...transfer("Pending"), asset: "Near" }];
    expect(await run()).toBe("noop");
    expect(near.calls).toEqual([]);
  });
});

describe("MPC key to address", () => {
  it("derives the Ethereum address from a NEAR secp256k1 public key", () => {
    const uncompressed = hexToBytes(vaultKey.publicKey).slice(1); // drop 0x04
    expect(ethAddressFromMpcKey(`secp256k1:${baseEncode(uncompressed)}`)).toBe(vaultKey.address);
  });
});
