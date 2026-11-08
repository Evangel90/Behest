# Behest

Non-custodial inheritance for digital assets, enforced by a NEAR contract and NEAR Chain Signatures. Behest does not determine death and is not a will. A missed check-in means **"owner unreachable"**, nothing more.

> **Status:** Stage 1 MVP in progress, testnet only. Never use real funds.

## Repository layout

| Path | What |
|---|---|
| `docs/stage0/` | Spec: state machine, permissions, signing boundary, schema, threat model, decisions |
| `contracts/behest/` | Rust NEAR contract (near-sdk 5.x) |
| `services/executor/` | TypeScript executor: broadcasts contract-signed Sepolia transfers, tracks confirmations, retries |

Planned (decision D1): `apps/web` (Next.js + the Open Ledger design system).

## Contract

```sh
cargo test                           # production timer bounds
cargo test --features demo-timers    # testnet demo timers (minutes)
cargo near build                     # deployable wasm (install: cargo install cargo-near)
```

Init: `new(admin, mpc_contract = "v1.signer-prod.testnet", eth_chain_id = 11155111, eth_max_fee_cap, eth_initial_max_fee, eth_priority_fee)` (fees in wei, as strings).

## Executor

```sh
pnpm install
pnpm --filter @behest/executor test
pnpm --filter @behest/executor vault <owner.testnet> [contract]   # print a plan's Sepolia vault address
cp services/executor/.env.example services/executor/.env           # then fill in, and:
pnpm --filter @behest/executor start
```

The executor holds no authority. It verifies that each signed transaction was signed by the plan's vault and matches the snapshot transfer, then broadcasts it and reports status. Anyone can run one; the admin registers executors with `add_executor`.

## MVP delivery progress

1. [x] Policy schema, state machine, permissions, invariants, timer profiles
2. [x] Plan creation, check-in, proposal, guardian approval/rejection, cancellation, eligibility
3. [x] NEAR escrow and heir claim
4. [x] Exact Sepolia transaction construction and Chain Signatures authorization
5. [x] Executor: broadcast, idempotency, confirmation tracking, retry
6. [x] Fee cap and reserve enforcement on retry
7. [ ] Role-based web app with policy and transaction previews
8. [ ] near-workspaces end-to-end tests, deploy scripts, demo docs
