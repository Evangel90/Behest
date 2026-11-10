import { describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import type { PlanView, Proposal } from "../src/diff.js";
import { Engine } from "../src/engine.js";
import { Watcher } from "../src/watcher.js";

const MIN = 60_000;
function plan(owner: string, status: PlanView["status"], proposal: Proposal | null = null, lastCheckIn = 0): PlanView {
  return {
    status,
    overdue_at_ms: lastCheckIn + 10 * MIN,
    now_ms: 12 * MIN,
    plan: { owner, last_check_in_ms: lastCheckIn, policy: { check_in_interval_ms: 10 * MIN, grace_ms: 0, quorum: 1, guardians: ["dayo.testnet"], heirs: [{ account_id: "amara.testnet" }] }, proposal, proposals_opened: proposal ? 1 : 0 },
  };
}

function chain() {
  const state = { plans: new Map<string, PlanView>(), open: [] as string[], history: new Map<string, Proposal[]>(), calls: [] as string[] };
  const view = async <T,>(method: string, args: Record<string, unknown>): Promise<T> => {
    state.calls.push(method);
    const owner = String(args.owner ?? "");
    switch (method) {
      case "list_open_releases":
        return state.open.slice(Number(args.from_index), Number(args.from_index) + 100) as T;
      case "get_plan":
        return (state.plans.get(owner) ?? null) as T;
      case "get_release_history":
        return (state.history.get(owner) ?? []) as T;
      case "get_config":
        return { erc20_tokens: [], nep141_tokens: [] } as T;
      default:
        return null as T;
    }
  };
  return { state, view };
}

describe("watcher", () => {
  it("watches open releases and subscribed owners, and tells a cancel from a settle", async () => {
    const store = new Store();
    const engine = new Engine(store, { maxAttempts: 3, retryBaseMs: 1000, rate: { email: 10, telegram: 10, webhook: 10 }, publicUrl: "http://n" }, {});
    const { state, view } = chain();
    const w = new Watcher(store, engine, view, { owners: [], contractId: "c" });
    // kemi subscribed: her own plan is watched for reminders even with nothing open
    store.addContact({ account: "kemi.testnet", channel: "email", address: "k@x.io", status: "active" });
    state.plans.set("kemi.testnet", plan("kemi.testnet", "Overdue"));
    const p: Proposal = { id: 3, proposer: "dayo.testnet", created_at_ms: 11 * MIN, approvals: ["dayo.testnet"], rejections: [], waiting_ends_at_ms: 20 * MIN, transfers: [] };
    state.plans.set("bola.testnet", plan("bola.testnet", "Waiting", p));
    state.open = ["bola.testnet"];
    expect((await w.tick()).notices).toBe(2); // kemi overdue; bola approved
    expect(store.deliveries("kemi.testnet:overdue:0")).toHaveLength(1);
    expect((await w.tick()).notices).toBe(0); // nothing new, nothing repeated
    // bola cancels: the release leaves list_open_releases but the snapshot remembers it
    state.open = [];
    state.plans.set("bola.testnet", plan("bola.testnet", "Active", null, 15 * MIN));
    await w.tick();
    expect(store.hasNotice("bola.testnet:cancelled:3")).toBe(true);
    expect(store.hasNotice("bola.testnet:settled:3")).toBe(false);
    // and nobody needs bola's plan any more
    expect(store.knownOwners()).toEqual(["kemi.testnet"]);
  });

  it("keeps the previous snapshot when a read fails, so no change is missed", async () => {
    const store = new Store();
    const engine = new Engine(store, { maxAttempts: 3, retryBaseMs: 1000, rate: { email: 10, telegram: 10, webhook: 10 }, publicUrl: "http://n" }, {});
    const { state, view } = chain();
    const p: Proposal = { id: 1, approvals: [], waiting_ends_at_ms: 20 * MIN, transfers: [] };
    state.plans.set("bola.testnet", plan("bola.testnet", "Waiting", p));
    state.open = ["bola.testnet"];
    let broken = false;
    const flaky = async <T,>(m: string, a: Record<string, unknown>) => (broken && m === "get_release_history" ? Promise.reject(new Error("rpc down")) : view<T>(m, a));
    const w = new Watcher(store, engine, flaky, { owners: [], contractId: "c" });
    await w.tick();
    state.plans.set("bola.testnet", plan("bola.testnet", "Active", null, 0));
    state.history.set("bola.testnet", [{ ...p }]);
    broken = true;
    expect((await w.tick()).errors).toBe(1);
    broken = false;
    await w.tick();
    expect(store.hasNotice("bola.testnet:settled:1")).toBe(true);
    expect(store.hasNotice("bola.testnet:cancelled:1")).toBe(false);
  });
});
