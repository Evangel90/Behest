import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commitment, commitmentText, parseRecordFile, recordFile, recordsFor } from "../src/lib/sealed";

const rec = { account_id: "amara.testnet", share_bps: 6000, near_destination: "amara.testnet", eth_destination: null, btc_destination: null, salt: "01".repeat(32) };

describe("D33 sealed heirs", () => {
  it("commits to the same text as the contract", async () => {
    const t = commitmentText("owner.testnet", rec, "behest.testnet");
    expect(t).toBe("behest-heir-v1\nbehest.testnet\nowner.testnet\namara.testnet\n6000\namara.testnet\n\n\n" + "01".repeat(32));
    expect(await commitment("owner.testnet", rec, "behest.testnet")).toBe(createHash("sha256").update(t).digest("hex"));
    // The contract's format string, kept in step with this one.
    const rs = readFileSync(new URL("../../../contracts/behest/src/privacy.rs", import.meta.url), "utf8");
    expect(rs).toContain('"behest-heir-v1\\n{}\\n{owner}\\n{}\\n{}\\n{}\\n{}\\n{}\\n{}"');
  });
  it("makes fresh salts and canonical records, and reads record files back", () => {
    const rs = recordsFor({ check_in_interval_ms: 1, grace_ms: 0, waiting_period_ms: 1, guardians: [], quorum: 1, heirs: [{ account_id: "a.testnet", share_bps: 10_000, near_destination: "a.testnet", eth_destination: "0xABCDEF0000000000000000000000000000000001" }] }, { "a.testnet": " tb1qxyz " });
    expect(rs[0]!.eth_destination).toBe("0xabcdef0000000000000000000000000000000001");
    expect(rs[0]!.btc_destination).toBe("tb1qxyz");
    expect(rs[0]!.salt).toMatch(/^[0-9a-f]{64}$/);
    const f = parseRecordFile(JSON.stringify(recordFile("owner.testnet", rec, "behest.testnet")))!;
    expect(f).toEqual({ owner: "owner.testnet", contract: "behest.testnet", record: rec });
    expect(parseRecordFile(JSON.stringify(rec))!.owner).toBeNull();
    expect(parseRecordFile("nope")).toBeNull();
  });
});
