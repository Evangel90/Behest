import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { NET, checkBtcTx } from "../src/bitcoin.js";
import { Engine } from "../src/engine.js";
import { memoryStore } from "../src/store.js";
import type { BtcPort, BtcTx, NearPort, PlanView, Transfer } from "../src/types.js";

const priv = new Uint8Array(32).fill(1);
const vault = btc.p2wpkh(secp256k1.getPublicKey(priv, true), NET);
const heir = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true), NET);
const COIN = "aa".repeat(31) + "01";
const OWNER = "owner.testnet";

function build(opts: { amount?: bigint; to?: string; extra?: boolean } = {}): BtcTx {
  const tx = new btc.Transaction({ version: 2 });
  tx.addInput({ txid: COIN, index: 1, witnessUtxo: { script: vault.script, amount: 100_000n }, sequence: 0xfffffffd });
  tx.addOutputAddress(opts.to ?? heir.address!, opts.amount ?? 60_000n, NET);
  tx.addOutputAddress(vault.address!, opts.extra ? 38_000n : 39_694n, NET);
  if (opts.extra) tx.addOutputAddress(heir.address!, 1_000n, NET);
  tx.sign(priv);
  tx.finalize();
  return { inputs: [{ txid: COIN, vout: 1, value: "100000" }], outputs: [], fee_rate: 2, fee: "306", seq: 0, txid: tx.id, sighashes: [], raw: tx.hex };
}

const transfer = (state: Transfer["state"], extra: Partial<Transfer> = {}): Transfer => ({
  heir: "amara.testnet", asset: "Btc", destination: heir.address!, amount: "60000", state,
  eth_tx: null, signature: null, attempts: 1, tx_hash: null, failure: null, ...extra,
});

function setup(t: Transfer, b: BtcTx, net: Partial<BtcPort> = {}, versions: BtcTx[] = []) {
  const calls: string[] = [];
  const near = {
    config: async () => ({ eth_max_fee_cap: "1", eth_chain_id: 1, mpc_contract: "m" }),
    listOpenReleases: async () => [OWNER],
    getPlan: async (): Promise<PlanView> => ({ plan: { owner: OWNER, version: 1, proposal: { id: 1, transfers: [t] } }, status: "Executing" }),
    vaultAddress: async () => { throw new Error("no eth"); },
    reportBroadcast: async (_o: string, i: number, h: string) => void calls.push(`broadcast:${i}:${h}`),
    reportConfirmed: async (_o: string, i: number, h: string) => void calls.push(`confirmed:${i}:${h}`),
    reportFailed: async (_o: string, i: number, r: string) => void calls.push(`failed:${i}:${r}`),
    retryTransfer: async (_o: string, i: number) => void calls.push(`retry:${i}`),
    listVaultWithdrawals: async () => [],
    getVaultWithdrawal: async () => null,
    getReleaseOptions: async () => null,
    getBtcTx: async () => b,
    getBtcRelease: async () => ({ last: 0 }),
    getBtcTxVersions: async () => versions,
    btcVaultAddress: async () => vault.address!,
  } as unknown as NearPort;
  const sent: string[] = [];
  const port: BtcPort = {
    broadcast: async (raw) => { sent.push(raw); return b.txid; },
    status: async () => null,
    tipHeight: async () => 100,
    outspend: async () => "unspent",
    ...net,
  };
  let now = 0;
  const engine = new Engine(near, {} as never, memoryStore(), { confirmations: 6, btcConfirmations: 2, stuckAfterMs: 1000, retryBackoffMs: 0, now: () => now, log: () => {} }, port);
  return { engine, calls, sent, tick: async () => (await engine.tick()).get(`${OWNER}#1#0`), advance: (ms: number) => (now += ms) };
}

describe("checkBtcTx", () => {
  it("accepts the contract's tx and rejects anything else", () => {
    const b = build();
    expect(checkBtcTx(b.raw!, b, transfer("Signed"), vault.address!)).toBeNull();
    expect(checkBtcTx(b.raw!, b, { destination: heir.address!, amount: "60001" }, vault.address!)).toBe("payout");
    expect(checkBtcTx(b.raw!, { ...b, txid: "00".repeat(32) }, transfer("Signed"), vault.address!)).toBe("txid");
    const extra = build({ extra: true });
    expect(checkBtcTx(extra.raw!, extra, transfer("Signed"), vault.address!)).toBe("change");
  });
});

describe("Bitcoin payouts", () => {
  it("broadcasts a signed payout and reports its txid", async () => {
    const b = build();
    const s = setup(transfer("Signed"), b);
    expect(await s.tick()).toBe("broadcast");
    expect(s.sent).toEqual([b.raw]);
    expect(s.calls).toEqual([`broadcast:0:${b.txid}`]);
  });

  it("refuses a payload that differs from the snapshot", async () => {
    const b = build({ amount: 50_000n });
    const s = setup(transfer("Signed"), b);
    expect(await s.tick()).toBe("needs-human");
    expect(s.sent).toEqual([]);
  });

  it("waits while the previous payout (its input) isn't on the network", async () => {
    const s = setup(transfer("Signed"), build(), { outspend: async () => null });
    expect(await s.tick()).toBe("waiting-for-earlier-nonce");
  });

  it("reports a conflict when a vault coin was spent by something else", async () => {
    const s = setup(transfer("Signed"), build(), { outspend: async () => "ff".repeat(32) });
    expect(await s.tick()).toBe("reported-failure");
    expect(s.calls).toEqual(["failed:0:Conflict"]);
  });

  it("adopts its own earlier broadcast", async () => {
    const b = build();
    const s = setup(transfer("Signed"), b, { outspend: async () => b.txid });
    expect(await s.tick()).toBe("broadcast");
    expect(s.sent).toEqual([]);
  });

  it("maps a low fee to Underpriced", async () => {
    const s = setup(transfer("Signed"), build(), { broadcast: async () => { throw new Error("min relay fee not met"); } });
    expect(await s.tick()).toBe("reported-failure");
    expect(s.calls).toEqual(["failed:0:Underpriced"]);
  });

  it("confirms after the required depth", async () => {
    const b = build();
    let tip = 100;
    const s = setup(transfer("Broadcast", { tx_hash: b.txid }), b, { status: async () => ({ confirmed: true, height: 100 }), tipHeight: async () => tip });
    expect(await s.tick()).toBe("noop");
    tip = 101;
    expect(await s.tick()).toBe("confirmed");
  });

  it("reports Stuck only for the latest payout, after the timeout", async () => {
    const b = build();
    const s = setup(transfer("Broadcast", { tx_hash: b.txid }), b, { status: async () => ({ confirmed: false, height: null }) });
    expect(await s.tick()).toBe("noop"); // starts the clock
    s.advance(2000);
    expect(await s.tick()).toBe("reported-failure");
    expect(s.calls).toEqual(["failed:0:Stuck"]);
  });

  it("rebroadcasts a dropped payout", async () => {
    const b = build();
    const s = setup(transfer("Broadcast", { tx_hash: b.txid }), b);
    await s.tick();
    expect(await s.tick()).toBe("rebroadcast");
    expect(s.sent).toEqual([b.raw]);
  });

  it("tracks a payout reported Stuck that the network took anyway, instead of re-signing", async () => {
    const b = build();
    const s = setup(transfer("Failed", { failure: "Stuck", tx_hash: b.txid }), b, { status: async () => ({ confirmed: true, height: 10 }) });
    expect(await s.tick()).toBe("rebroadcast");
    expect(s.calls).toEqual([`broadcast:0:${b.txid}`]);
  });

  it("re-signs a Stuck payout the network doesn't have", async () => {
    const b = build();
    const s = setup(transfer("Failed", { failure: "Stuck", tx_hash: b.txid }), b);
    expect(await s.tick()).toBe("retried");
  });

  it("does not retry a conflict (a guardian must rebase)", async () => {
    const s = setup(transfer("Failed", { failure: "Conflict" }), build());
    expect(await s.tick()).toBe("needs-human");
  });

  describe("fee-bumped versions", () => {
    const old = { ...build({ amount: 60_000n }), txid: "0b".repeat(32) };

    it("broadcasts the bump as a replacement of its own earlier version", async () => {
      const b = build();
      const s = setup(transfer("Signed"), b, { outspend: async () => old.txid }, [old]);
      expect(await s.tick()).toBe("broadcast");
      expect(s.sent).toEqual([b.raw]);
      expect(s.calls).toEqual([`broadcast:0:${b.txid}`]);
    });

    it("keeps the earlier version when it was already mined", async () => {
      const b = build();
      const s = setup(transfer("Signed"), b, {
        outspend: async () => old.txid,
        broadcast: async () => { throw new Error("bad-txns-inputs-missingorspent"); },
        status: async (id) => (id === old.txid ? { confirmed: true, height: 99 } : null),
      }, [old]);
      expect(await s.tick()).toBe("broadcast");
      expect(s.calls).toEqual([`broadcast:0:${old.txid}`]);
    });

    it("asks for another bump when the replacement is underpriced", async () => {
      const b = build();
      const s = setup(transfer("Signed"), b, {
        outspend: async () => old.txid,
        broadcast: async () => { throw new Error("insufficient fee, rejecting replacement"); },
        status: async () => ({ confirmed: false, height: null }),
      }, [old]);
      expect(await s.tick()).toBe("reported-failure");
      expect(s.calls).toEqual(["failed:0:Underpriced"]);
    });

    it("tracks the earlier version instead of calling it a conflict", async () => {
      const b = build();
      const s = setup(transfer("Broadcast", { tx_hash: b.txid }), b, { outspend: async () => old.txid }, [old]);
      await s.tick(); // first sight: start the clock
      expect(await s.tick()).toBe("broadcast");
      expect(s.calls).toEqual([`broadcast:0:${old.txid}`]);
    });

    it("reports a winning earlier version rather than retrying", async () => {
      const b = build();
      const s = setup(transfer("Failed", { failure: "Stuck" }), b, { outspend: async () => old.txid }, [old]);
      expect(await s.tick()).toBe("broadcast");
      expect(s.calls).toEqual([`broadcast:0:${old.txid}`]);
    });

    it("still reports a spend by an unknown transaction as a conflict", async () => {
      const b = build();
      const s = setup(transfer("Signed"), b, { outspend: async () => "0c".repeat(32) }, [old]);
      expect(await s.tick()).toBe("reported-failure");
      expect(s.calls).toEqual(["failed:0:Conflict"]);
    });
  });
});
