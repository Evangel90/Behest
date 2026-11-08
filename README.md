# Behest

Non-custodial inheritance for digital assets, enforced by a NEAR contract and NEAR Chain Signatures. Behest does not determine death and is not a will. A missed check-in means **"owner unreachable"**, nothing more.

> **Status:** Stage 1 MVP in progress, testnet only. Never use real funds.

## Repository layout

| Path | What |
|---|---|
| `docs/stage0/` | Spec: state machine, permissions, signing boundary, schema, threat model, decisions |
| `contracts/behest/` | Rust NEAR contract (near-sdk 5.x) |
| `services/executor/` | TypeScript executor: broadcasts contract-signed Sepolia transfers, tracks confirmations, retries |
| `services/relayer/` | Gas relayer: pays NEAR gas (NEP-366 meta-transactions) so heirs, guardians and owner check-ins need no NEAR |
| `tools/testnet/` | Testnet deploy script and live end-to-end scenarios |
| `deployments/testnet.json` | Current testnet deployment (public account IDs, wasm hash) |

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

## Gas relayer

```sh
pnpm --filter @behest/relayer test
pnpm --filter @behest/relayer start     # needs RELAYER_ACCOUNT_ID / RELAYER_PRIVATE_KEY in .env
```

Clients sign a delegate action and `POST /relay {"signed_delegate": "<base64 borsh>"}`; `@behest/relayer/client` exports `sponsoredCall()` for this. The relayer only pays gas. It sponsors a single, zero-deposit call to the Behest contract, limited to `claim`, `retry_transfer`, `propose_release`, `approve_release`, `reject_release`, `check_in` and `cancel_release`, and only when the sender actually holds that role in the plan. Rate limits apply per sender and globally. Plan edits, deposits and withdrawals are never sponsored. The contract still authorizes everything, so a compromised relayer can waste its own NEAR but cannot move funds.

## Testnet deployment and live e2e

Current deployment: see `deployments/testnet.json` (contract `behest-ekkr6.testnet`, demo timers).

```sh
cp .env.example .env    # fill SEPOLIA_FUNDER_KEY (test-only private key) and SEPOLIA_RPC_URL
# accounts behest-<suffix>[-admin|-exec|-owner|-g1|-g2|-g3|-amara|-tobi].testnet, via the faucet:
near account create-account sponsor-by-faucet-service behest-<suffix>-owner.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
(cd contracts/behest && cargo near build non-reproducible-wasm --features demo-timers --out-dir ../../target/near-demo)
pnpm --filter @behest/testnet deploy-contract <suffix>   # deploy + init + register executor; writes .env NEAR fields
pnpm --filter @behest/testnet e2e                        # NEAR-side scenarios (≈ 8 min, demo timers)
pnpm --filter @behest/testnet e2e-eth                    # Chain Signatures → executor → Sepolia (needs funded key)
```

| Scenario | Shows |
|---|---|
| `happy-near` | Plan → owner unreachable → 2-of-3 guardians → wait → heirs claim NEAR → Settled |
| `owner-cancel` | One owner check-in during the waiting period cancels the release and restores escrow |
| `missing-guardian` | 3-of-3 quorum with a guardian absent: release stays paused; threshold never lowered |
| `insufficient-fee-reserve` | Proposal refused when the ETH vault can't cover the network-fee reserve |
| `sponsored` | Guardians vote and heirs claim through the relayer, spending exactly 0 NEAR; strangers and non-sponsored methods rejected (needs a running relayer) |
| `authorization` | Live negative checks: non-guardian propose, frozen edits/withdrawals, executor-only reports, admin-only pause |
| `e2e-eth` | MPC-signed Sepolia transfer, 60 s executor outage with nothing lost, then broadcast and confirmation |

### Known MVP limitation surfaced by the live run

After a release, the vault keeps the unused network-fee reserve, the rounding remainder, and the ETH share of any heir without an ETH destination (D12, 04-policy-schema). The owner can't withdraw ETH yet (D7), so that balance stays in the vault. Owner ETH withdrawal and an explicit residual rule are Stage 2 must-haves before any mainnet use.

## MVP delivery progress

1. [x] Policy schema, state machine, permissions, invariants, timer profiles
2. [x] Plan creation, check-in, proposal, guardian approval/rejection, cancellation, eligibility
3. [x] NEAR escrow and heir claim
4. [x] Exact Sepolia transaction construction and Chain Signatures authorization
5. [x] Executor: broadcast, idempotency, confirmation tracking, retry
6. [x] Fee cap and reserve enforcement on retry
7. [x] Gas relayer for heirs and guardians (pulled forward from Stage 2; D14)
8. [ ] Role-based web app with policy and transaction previews
9. [x] Deploy scripts and live testnet e2e (all scenarios passing; first Sepolia release: [0x38e3…b323](https://sepolia.etherscan.io/tx/0x38e3a54ce63bba4b1a1940981bee6fe15e3f7c5cfac17b23ff14e9314381b323))
