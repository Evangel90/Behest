import { describe, expect, it } from "vitest";
import { councilMembers, councilReader, withCouncils } from "../src/council.js";
import { Store } from "../src/db.js";
import type { PlanView } from "../src/diff.js";
import { Engine } from "../src/engine.js";
import { Watcher } from "../src/watcher.js";

const POLICY = {
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"] },
    { name: "council", kind: { Group: ["kemi.testnet", "dayo.testnet"] }, permissions: ["*:*"] },
    { name: "auditors", kind: { Group: ["ife.testnet", "kemi.testnet"] }, permissions: ["*:VoteApprove"] },
  ],
};

describe("DAO councils (D26)", () => {
  it("reads every Group member of the policy once", () => {
    expect(councilMembers(POLICY as never)).toEqual(["dayo.testnet", "ife.testnet", "kemi.testnet"]);
    expect(councilMembers(null)).toEqual([]);
  });

  it("caches the council, treats accounts without get_policy as not a DAO, and rides out RPC errors", async () => {
    let t = 0;
    let fail: Error | null = null;
    const calls: string[] = [];
    const viewAt = async <T,>(c: string): Promise<T> => {
      calls.push(c);
      if (fail) throw fail;
      if (c === "kemi.testnet") throw new Error("CodeDoesNotExist");
      return POLICY as T;
    };
    const of = councilReader(viewAt, 1000, () => t);
    expect(await of("family.sputnikv2.testnet")).toHaveLength(3);
    expect(await of("family.sputnikv2.testnet")).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(await of("kemi.testnet")).toBeNull();
    t = 5000;
    fail = new Error("429 rate limit");
    expect(await of("family.sputnikv2.testnet")).toHaveLength(3); // last known council
    await expect(of("new.sputnikv2.testnet")).rejects.toThrow("429");
  });

  it("adds an opted-in DAO's council to the recipients", async () => {
    const of = async (dao: string) => (dao === "family.sputnikv2.testnet" ? ["kemi.testnet", "dayo.testnet"] : null);
    expect(await withCouncils(["family.sputnikv2.testnet", "amara.testnet"], (a) => a === "family.sputnikv2.testnet", of)).toEqual(["family.sputnikv2.testnet", "amara.testnet", "kemi.testnet", "dayo.testnet"]);
    expect(await withCouncils(["family.sputnikv2.testnet"], () => false, of)).toEqual(["family.sputnikv2.testnet"]);
  });

  it("delivers a DAO owner's reminders to each council member's own contacts", async () => {
    const MIN = 60_000;
    const store = new Store();
    const engine = new Engine(store, { maxAttempts: 3, retryBaseMs: 1000, rate: { email: 10, telegram: 10, webhook: 10 }, publicUrl: "http://n" }, {});
    const dao = "family.sputnikv2.testnet";
    const view = async <T,>(method: string, args: Record<string, unknown>): Promise<T> => {
      if (method === "list_open_releases") return [] as T;
      if (method === "get_plan" && args.owner === dao) {
        const v: PlanView = {
          status: "Overdue",
          overdue_at_ms: 10 * MIN,
          now_ms: 12 * MIN,
          plan: { owner: dao, last_check_in_ms: 0, policy: { check_in_interval_ms: 10 * MIN, grace_ms: 0, quorum: 1, guardians: ["g.testnet"], heirs: [{ account_id: "amara.testnet" }] }, proposal: null, proposals_opened: 0 },
        };
        return v as T;
      }
      return null as T;
    };
    const w = new Watcher(store, engine, view, { owners: [], contractId: "c", councilOf: async (d) => (d === dao ? ["kemi.testnet", "dayo.testnet"] : null) });
    store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    store.addContact({ account: "dayo.testnet", channel: "email", address: "d@x.io", status: "active" });
    // Not switched on: the DAO's plan isn't even read.
    expect((await w.tick()).notices).toBe(0);
    store.setCouncil(dao, "kemi.testnet", true);
    expect((await w.tick()).notices).toBe(1);
    expect(store.deliveries(`${dao}:overdue:0`).map((d) => d.account).sort()).toEqual(["dayo.testnet", "kemi.testnet"]);
  });
});
