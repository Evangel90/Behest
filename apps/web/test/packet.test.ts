import { describe, expect, it } from "vitest";
import { buildPacket, cliCommands, isEthImplicit, networkOf, timelineWords } from "../src/lib/packet";
import { modeFor } from "../src/lib/plan";
import type { PlanInput, ReleaseOptions, ReleaseRules } from "../src/lib/types";

const DAY = 86_400_000;
const policy: PlanInput = {
  check_in_interval_ms: 90 * DAY,
  grace_ms: 7 * DAY,
  waiting_period_ms: 30 * DAY,
  guardians: ["dayo.testnet", "funmi.testnet", "chidi.testnet"],
  quorum: 2,
  heirs: [
    { account_id: "amara.testnet", share_bps: 6000, near_destination: "amara.testnet", eth_destination: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" },
    { account_id: "tobi.testnet", share_bps: 4000, near_destination: "tobi.testnet", eth_destination: null },
  ],
};
const options: ReleaseOptions = {
  mode: "Automatic",
  hybrid_grace_ms: 0,
  delay_signers: ["d1.testnet", "d2.testnet"],
  delay_quorum: 2,
  max_extension_ms: 14 * DAY,
  max_total_extension_ms: 30 * DAY,
  overrides: [
    { heir: "amara.testnet", assets: "Ethereum", mode: "Claim", hybrid_grace_ms: 0 },
    { heir: null, assets: "Bitcoin", mode: "Hybrid", hybrid_grace_ms: 7 * DAY },
  ],
};
const rules: ReleaseRules = {
  fixed: [{ heir: "tobi.testnet", asset: "Near", amount: "1000000000000000000000000" }],
  remainder_to: null,
  alternates: [{ heir: "amara.testnet", recipient: { account_id: "kemi.testnet", near_destination: "kemi.testnet", eth_destination: null } }],
  fallback: { account_id: "charity.testnet", near_destination: "charity.testnet", eth_destination: null },
  claim_window_ms: 60 * DAY,
};
const src = {
  contract: "behest-x.testnet",
  owner: "owner.testnet",
  version: 3,
  policy,
  rules,
  options,
  btcDestinations: [{ account_id: "tobi.testnet", address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" }],
  ethVault: "0xabc",
  btcVault: null,
  appUrl: "https://app.example/",
  generatedAt: Date.UTC(2026, 10, 11),
};

describe("modeFor", () => {
  it("follows the contract: first matching override, else the plan mode", () => {
    expect(modeFor(null, "amara.testnet", "Near").mode).toBe("Claim");
    expect(modeFor(options, "amara.testnet", "Ethereum").mode).toBe("Claim");
    expect(modeFor(options, "tobi.testnet", "Ethereum").mode).toBe("Automatic");
    expect(modeFor(options, "tobi.testnet", "Bitcoin")).toEqual({ mode: "Hybrid", grace_ms: 7 * DAY });
  });
});

describe("recovery packet", () => {
  it("describes every heir with destinations, rules and modes", () => {
    const pk = buildPacket(src);
    expect(pk.network).toBe("testnet");
    expect(pk.plan_url).toBe("https://app.example/plan/owner.testnet");
    expect(pk.heirs.map((h) => h.share)).toEqual(["60%", "40%"]);
    const [amara, tobi] = pk.heirs;
    expect(amara!.alternate?.account_id).toBe("kemi.testnet");
    expect(amara!.modes.map((m) => [m.group, m.mode])).toEqual([["Near", "Automatic"], ["Ethereum", "Claim"]]);
    expect(amara!.mustClaim).toBe(true);
    expect(tobi!.destinations.bitcoin).toMatch(/^tb1q/);
    expect(tobi!.fixed).toEqual(["1 NEAR"]);
    expect(tobi!.modes.map((m) => m.mode)).toEqual(["Automatic", "Hybrid"]);
    expect(pk.delay_signers?.quorum).toBe(2);
    expect(JSON.stringify(pk)).not.toMatch(/secret|private/i);
  });

  it("can be tailored to one heir", () => {
    expect(buildPacket(src, "tobi.testnet").heirs.map((h) => h.account_id)).toEqual(["tobi.testnet"]);
    expect(buildPacket(src, "nobody.testnet").heirs).toEqual([]);
  });

  it("explains the timeline and gives runnable CLI commands", () => {
    const pk = buildPacket(src);
    const words = timelineWords(pk).join(" ");
    expect(words).toContain("90 days");
    expect(words).toContain("2 of the 3 guardians");
    expect(words).toContain("delay signers");
    const claim = cliCommands(pk, "amara.testnet").find((c) => c.cmd.includes(" claim "))!;
    expect(claim.cmd).toContain(`behest-x.testnet claim json-args '{"owner":"owner.testnet"}'`);
    expect(claim.cmd).toContain("sign-as amara.testnet network-config testnet");
  });

  it("knows networks and Ethereum-wallet accounts", () => {
    expect(networkOf("behest.near")).toBe("mainnet");
    expect(isEthImplicit("0x" + "ab".repeat(20))).toBe(true);
    expect(isEthImplicit("amara.testnet")).toBe(false);
  });
});
