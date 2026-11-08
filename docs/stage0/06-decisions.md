# 06 · Decision log

| ID | Decision | Rationale | Revisit |
|---|---|---|---|
| D1 | **Monorepo:** `contracts/behest` (Rust, near-sdk 5.x, built with cargo-near), `services/executor` (TypeScript, Node), `apps/web` (Next.js + Tailwind using the Open Ledger tokens), `packages/` for shared types. pnpm workspaces | Rust has the best Chain Signatures tooling (`omni-transaction`) and the most mature testing (`near-workspaces`). One TS stack covers the executor and web app | — |
| D2 | **External chain for MVP:** Sepolia ETH (native only) | Simplest Chain Signatures adapter; no UTXO handling | Stage 2 adds Bitcoin testnet and ERC-20 |
| D3 | **One contract, many plans:** one plan per owner, keyed by owner account | Simple discovery and indexing | Stage 3 if multiple plans per owner are needed |
| D4 | **NEAR custody:** NEAR is deposited into contract escrow per plan; the owner withdraws freely with no open proposal | Contract can transfer NEAR directly without an executor | — |
| D5 | **Balance snapshot at proposal time**; withdrawals frozen while a proposal is open; later deposits not distributed in MVP | Matches the guardian-approves-a-snapshot model | Stage 2: recount and later-deposit rules |
| D6 | **ETH fee model:** fees paid from the vault; reserve `heirs × eth_gas_limit × max_fee_cap` at proposal; `max_fee_cap` and `eth_gas_limit` set by admin, gas limit snapshotted per proposal (was a fixed 21000 until Glamsterdam made first transfers to unused addresses cost ≈207k) | Heir needs no ETH; caps bound the cost | Stage 2: per-chain reserves and quotes |
| D7 | **Owner ETH withdrawal deferred** | Owner withdrawals consume vault nonces and complicate nonce ordering. Testnet value is zero | Stage 2 (must ship before any mainnet) |
| D8 | **Executor:** team-operated, but contract-registered and replaceable; anyone can rebroadcast the public signed tx | Proves replaceability without building a market | Stage 3: second independent executor |
| D9 | **Upgrade and pause authority:** single admin account on testnet; pause covers new plans and new sign requests only | Speed for MVP; risk documented (05 #13) | Stage 4: time-locked multisig |
| D10 | **Privacy:** fully public plan data on testnet | Roadmap Stage 1 scope | Stage 3: commitments |
| D11 | **Notifications:** console/email from the executor; never affect contract state | Roadmap Stage 1 scope | Stage 2 workflows |
| D12 | **Rounding remainder stays in the vault/escrow** | No implicit recipient | Stage 2 explicit remainder rule |
| D13 | **Proposal rejection:** a proposal dies once enough guardians reject that quorum is impossible | Prevents a deadlocked proposal from blocking new ones | — |
| D15 | **ERC-20 adapter (Stage 2):** admin allowlist (≤ 4 reverting tokens; testnet WETH) stored outside the contract struct; transfers snapshot the token address; one fee reserve per vault transaction; same vault, nonce sequence, executor and recovery path as ETH | Reuses the proven ETH signing path. A second asset is needed for the partial-failure demo. No state migration needed | Per-plan token opt-in; balance proofs instead of reported balances |
| D14 | **NEAR gas for heirs and guardians** is sponsored by a NEP-366 relayer in the MVP (revised; originally heirs paid) | People inheriting or vouching shouldn't need to buy NEAR first. The relayer only pays gas: it sponsors one allowlisted, non-payable Behest call per meta-transaction, only for the sender's actual role in that plan, with per-sender and global rate limits. The contract still authorizes every call. | Direct calls still work if the relayer is down |

## Deferred (explicitly)

Production timer values, attestations, delay signers, guardian replacement while inactive, automatic and hybrid claims, NEP-141 tokens, Bitcoin, privacy modes, and legal review. (ERC-20 moved into Stage 2 work: D15.) See the roadmap stages.
