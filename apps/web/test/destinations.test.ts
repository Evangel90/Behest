import { describe, expect, it } from "vitest";
import { proofHow, sigHex } from "../src/lib/destinations";

describe("D30 proof helpers", () => {
  it("reads BIP-137 signatures as wallets show them (base64) or hex", () => {
    const hex = "27" + "ab".repeat(64);
    const b64 = btoa(String.fromCharCode(...hex.match(/../g)!.map((h) => parseInt(h, 16))));
    expect(sigHex(b64)).toBe(hex);
    expect(sigHex(`0x${hex}`)).toBe(hex);
    expect(sigHex("not a signature")).toBeNull();
    expect(sigHex(btoa("short"))).toBeNull();
  });
  it("picks how a destination is proven", () => {
    expect(proofHow("Near", "amara.testnet")).toBe("near");
    expect(proofHow("Intents", "0x" + "a".repeat(40))).toBe("eth");
    expect(proofHow("Btc", "tb1qxyz")).toBe("btc");
    expect(proofHow("Btc", "tb1pxyz")).toBe("taproot");
  });
});
