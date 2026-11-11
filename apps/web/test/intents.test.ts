import { describe, expect, it } from "vitest";
import { describeAction } from "../src/lib/evm/action";
import { intentsTarget, type IntentsDelivery } from "../src/lib/intents";
import { failureText } from "../src/lib/plan";
import { allows, features, reasonFor, tierPerks, type TierSpec } from "../src/lib/tiers";
import { heirErrors, intentsDeliveries, type HeirDraft } from "../src/lib/wizard";

const heir = (x: Partial<HeirDraft>): HeirDraft => ({ account: "amara.testnet", pct: "100", near: "", eth: "", ...x });

describe("D27: NEAR Intents delivery", () => {
  it("pays opted-in recipients into their Intents account, defaulting to their NEAR destination", () => {
    const ds: IntentsDelivery[] = [
      { account_id: "amara.testnet", enabled: true, intents_account: null },
      { account_id: "tobi.testnet", enabled: true, intents_account: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" },
      { account_id: "kemi.testnet", enabled: false, intents_account: null },
    ];
    expect(intentsTarget(ds, "amara.testnet", "amara-wallet.testnet")).toBe("amara-wallet.testnet");
    expect(intentsTarget(ds, "amara.testnet", null)).toBe("amara.testnet");
    expect(intentsTarget(ds, "tobi.testnet", "tobi.testnet")).toBe("0x71c7656ec7ab88b098defb751b7401b5f6d8976f");
    expect(intentsTarget(ds, "kemi.testnet", "kemi.testnet")).toBeNull();
    expect(intentsTarget(ds, "stranger.testnet")).toBeNull();
  });

  it("builds set_intents_delivery from the wizard draft and checks the Intents account", () => {
    const heirs = [heir({ intents: true, intentsAccount: " 0x71C7656EC7ab88b098defB751B7401B5f6d8976F " }), heir({ account: "tobi.testnet", pct: "0", intents: false }), heir({ account: "kemi.testnet", pct: "0", intents: true })];
    expect(intentsDeliveries(heirs)).toEqual([
      { account_id: "amara.testnet", enabled: true, intents_account: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" },
      { account_id: "kemi.testnet", enabled: true, intents_account: null },
    ]);
    expect(heirErrors([heir({ intents: true, intentsAccount: "not an account!" })], "owner.testnet", [])["heir.0.intents"]).toBeTruthy();
    // An Intents account typed while the box is unticked is ignored.
    expect(heirErrors([heir({ intents: false, intentsAccount: "not an account!" })], "owner.testnet", [])["heir.0.intents"]).toBeUndefined();
  });

  it("is a Standard feature, gated with cross-chain delivery", () => {
    const free: TierSpec = { name: "Free", price: "0", max_heirs: 1, max_guardians: 3, external_assets: false, release_rules: false, advanced_release: false };
    const std: TierSpec = { name: "Standard", price: "49000000", max_heirs: 5, max_guardians: 5, external_assets: true, release_rules: true, advanced_release: false };
    const f = features({ heirs: [{ account_id: "a", share_bps: 10000, near_destination: null, eth_destination: null }], guardians: ["g"] }, null, null, 0, false, 0, true);
    expect(f.intents_delivery).toBe(true);
    expect(allows(free, f)).toBe(false);
    expect(allows(std, f)).toBe(true);
    expect(reasonFor({ fee_token: "u", fee_symbol: "USDC", fee_decimals: 6, tiers: [free, std] }, 0, f)).toBe("delivery through NEAR Intents");
    expect(tierPerks(std).join(" ")).toContain("NEAR Intents");
  });

  it("explains refunds as failures and describes the call for Ethereum wallets", () => {
    const t = { heir: "amara.testnet", asset: "Near" as const, amount: "1", destination: "amara.testnet", state: "Failed" as const, attempts: 1, tx_hash: null, confirmed_at_ms: null };
    expect(failureText({ ...t, failure: "IntentsRefunded" } as never)).toMatch(/nothing counts as paid/);
    expect(failureText({ ...t, failure: "IntentsPartlyRefunded" } as never)).toMatch(/only the rest/);
    expect(describeAction("set_intents_delivery", { deliveries: [{ account_id: "amara.testnet", enabled: true, intents_account: null }] }, "owner.testnet")).toBe("Pay amara.testnet through NEAR Intents");
    expect(describeAction("set_intents_delivery", { deliveries: [] }, "owner.testnet")).toBe("Stop paying heirs through NEAR Intents");
  });
});
