import { describe, expect, it } from "vitest";
import { GAS_RESERVE, MIN_SWEEP, YOCTO_PER_BYTE, sweepVaults, sweepable, type NearVaultPort, type Sweep } from "../src/nearvault.js";

const NEAR = 10n ** 24n;

function fake(balance: bigint, opts: { nonce?: bigint; signs?: boolean; sweep?: Sweep | null } = {}) {
  const calls: { amount: bigint; nonce: bigint }[] = [];
  const sent: string[] = [];
  let sweep: Sweep | null = opts.sweep ?? null;
  const p: NearVaultPort = {
    listVaults: async () => [["kemi.testnet", "ab".repeat(32)]],
    account: async () => (balance ? { amount: balance, storageUsage: 182 } : null),
    accessKeyNonce: async () => opts.nonce ?? 100n,
    vaultPublicKey: async () => "ed25519:x",
    blockHash: async () => "BH",
    requestSweep: async (_o, amount, nonce) => {
      calls.push({ amount, nonce });
      sweep = { nonce: Number(nonce), amount: amount.toString(), signed_tx: opts.signs === false ? null : `signed-${nonce}` };
    },
    getSweep: async () => sweep,
    broadcast: async (s) => (sent.push(s), "txhash"),
  };
  return { p, calls, sent };
}

describe("NEAR vault sweeper", () => {
  it("leaves storage, gas and dust behind", () => {
    const keep = 182n * YOCTO_PER_BYTE + GAS_RESERVE;
    expect(sweepable(NEAR, 182)).toBe(NEAR - keep);
    expect(sweepable(keep + MIN_SWEEP - 1n, 182)).toBe(0n);
    expect(sweepable(keep + MIN_SWEEP, 182)).toBe(MIN_SWEEP);
  });
  it("asks for a sweep at the next nonce and broadcasts it", async () => {
    const f = fake(NEAR);
    expect((await sweepVaults(f.p, () => {})).get("kemi.testnet")).toBe("swept");
    expect(f.calls).toEqual([{ amount: sweepable(NEAR, 182), nonce: 101n }]);
    expect(f.sent).toEqual(["signed-101"]);
  });
  it("re-sends a signed sweep for the same nonce instead of signing again", async () => {
    const f = fake(NEAR, { sweep: { nonce: 101, amount: "1", signed_tx: "old" } });
    await sweepVaults(f.p, () => {});
    expect(f.calls).toEqual([]);
    expect(f.sent).toEqual(["old"]);
  });
  it("skips empty vaults and waits for a signature", async () => {
    expect((await sweepVaults(fake(0n).p, () => {})).get("kemi.testnet")).toBe("empty");
    const f = fake(NEAR, { signs: false });
    expect((await sweepVaults(f.p, () => {})).get("kemi.testnet")).toBe("unsigned");
    expect(f.sent).toEqual([]);
  });
});
