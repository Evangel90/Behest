# Behest

Non-custodial inheritance for digital assets, enforced by a NEAR contract and NEAR Chain Signatures. Behest does not determine death and is not a will. A missed check-in means **"owner unreachable"**, nothing more.

> **Status:** Stage 1 MVP in progress, testnet only. Never use real funds.

## Repository layout

| Path | What |
|---|---|
| `docs/stage0/` | Spec: state machine, permissions, signing boundary, schema, threat model, decisions |
| `contracts/behest/` | Rust NEAR contract (near-sdk 5.x) |
| `services/executor/` | TypeScript executor: broadcasts contract-signed Sepolia transfers, tracks confirmations, retries |
| `apps/web/` | Next.js web app: landing, owner dashboard and setup, guardian approval, mobile heir claim, public inspector, “Try as…” personas |
| `services/notifier/` | Read-only notifier: check-in reminders and lifecycle notices to the console and an optional webhook |
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

## Web app

```sh
pnpm --filter @behest/relayer start     # in one terminal (sponsored gas)
pnpm --filter @behest/web dev           # http://localhost:3000
pnpm --filter @behest/web test          # plan-logic unit tests
pnpm --filter @behest/web smoke         # live: Try-as sandbox → release → Settled, via the app's own signing code
```

Sign-in options:
- **NEAR wallets** through NEAR Connect (HOT, Meteor, Intear, MyNearWallet, Ledger, WalletConnect). Wallets that can sign delegate actions get gas sponsored for heir, guardian and check-in calls.
- **Ethereum wallets** (MetaMask and others) through NEAR Connect's Ethereum Wallets module, acting from the eth-implicit `0x…` NEAR account. These wallets can't sign delegate actions, so they pay their own gas.
- **Email, Google or passkey** through NEAR Auth. Shown, but switched off until `NEXT_PUBLIC_NEAR_AUTH_CLIENT_ID` is set, because NEAR has to issue that client ID.
- **Try as…** (testnet only). `/api/demo` creates six funded accounts under `DEMO_FUNDER_ACCOUNT_ID` from public keys the browser generates. The private keys never leave the browser. Rate limits: 3 sandboxes per hour per IP and 30 per day.

Heirs see the paper theme in plain language; hashes appear only under "Technical details". Anyone can open `/plan/<owner>?view=inspect`.

## Notifier

```sh
pnpm --filter @behest/notifier test
NOTIFY_OWNERS=kemi.testnet pnpm --filter @behest/notifier start   # optional NOTIFY_WEBHOOK_URL (Slack/Discord-style JSON)
```

It sends:
- an owner reminder once 75% of the check-in window has passed;
- notices on unreachable, proposed, approved (with the cancel deadline), cancelled, ready to receive, transfer failed, and settled.

Each notice has a stable key, so restarts never repeat one. The notifier holds no keys, and a missed notice can't change a plan. It watches every open release plus the owners in `NOTIFY_OWNERS`; the contract doesn't list all plans.

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
(cd contracts/behest && cargo near build non-reproducible-wasm --features demo-timers --out-dir ../../target/near-demo)

# Accounts: either nine faucet accounts behest-<suffix>[-admin|-exec|-owner|-g1|-g2|-g3|-amara|-tobi].testnet …
near account create-account sponsor-by-faucet-service behest-<suffix>-owner.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
pnpm --filter @behest/testnet deploy-contract <suffix>   # deploy + init + register executor; writes .env NEAR fields

# … or, when the faucet rate-limits, sub-accounts of one funded account (≈ 10.3 NEAR; resumable):
pnpm --filter @behest/testnet bootstrap <suffix> --parent <funded.testnet>
BEHEST_DEPLOYMENT=<name> pnpm --filter @behest/testnet deploy-contract <suffix> --parent <funded.testnet>

pnpm --filter @behest/testnet e2e                        # NEAR-side scenarios (≈ 15 min, demo timers)
pnpm --filter @behest/testnet e2e-eth                    # Chain Signatures → executor → Sepolia (needs funded key)
pnpm --filter @behest/testnet bootstrap <suffix> --parent <funded.testnet> --teardown   # return the NEAR (all but the contract's storage)
```

`BEHEST_DEPLOYMENT=<name>` makes every script read and write `deployments/<name>.json` instead of the main `testnet.json`, and stops `deploy-contract` writing the main deployment's `.env` fields. The `sponsored` scenario needs a relayer for that contract: `BEHEST_CONTRACT_ID=<contract> RELAYER_PORT=8788 pnpm --filter @behest/relayer start`, then set `RELAYER_URL=http://localhost:8788` for the run.

| Scenario | Shows |
|---|---|
| `happy-near` | Plan → owner unreachable → 2-of-3 guardians → wait → heirs claim NEAR → Settled |
| `owner-cancel` | One owner check-in during the waiting period cancels the release and restores escrow |
| `missing-guardian` | 3-of-3 quorum with a guardian absent: release stays paused; threshold never lowered |
| `insufficient-fee-reserve` | Proposal refused when the ETH vault can't cover the network-fee reserve |
| `sponsored` | Guardians vote and heirs claim through the relayer, spending exactly 0 NEAR; strangers and non-sponsored methods rejected (needs a running relayer) |
| `authorization` | Live negative checks: non-guardian propose, frozen edits/withdrawals, executor-only reports, admin-only pause |
| `e2e-eth` | Two heirs, each receiving ETH and WETH, with freshly generated Sepolia wallets: MPC signs nonces 0–3 in claim order, a 60 s executor outage loses nothing, the executor holds each later nonce until the earlier one is mined, each heir receives exactly its ETH and WETH share, and test ETH and WETH are swept back to the funder |
| `e2e-auto` | Delay signers and automatic release: two delay signers extend an approved release's waiting period by one minute (a heir's claim inside it is refused), then the executor starts both heirs' transfers by itself; the heirs sign nothing and receive exactly their shares |
| `e2e-rules` | Release rules: 0.05 NEAR + 7 yocto with a 0.01 NEAR fixed amount for Tobi, the rest 60/40, the remainder to Amara (every yocto distributed). Nobody claims; after the 1-minute claim window Amara's share moves to her named alternate and Tobi's to the fallback, and both claim it |
| `e2e-nep141` | NEP-141: the owner wraps NEAR and deposits wNEAR (a deposit for an unknown plan is refunded), withdraws part of it, then the release splits it 60/40 to two fresh accounts the contract registers with the token first; heirs hold exactly their shares and the registration reserve is spent exactly |
| `e2e-partial` | Partial failure across two assets: a guardian over-reports the vault's WETH, Amara's ETH confirms, and her WETH is caught before broadcast (`WouldRevert`: no fee spent, nonce kept). After a top-up she retries; WETH is re-signed at the same nonce and confirms, the confirmed ETH transfer is never touched, and she ends with exactly one share of each |
| `recover-vaults <owner>…` | Withdraws what earlier runs left in plan vaults back to the funder via D7 (re-creates deleted scenario owner accounts by name) |
| `reissue <owner> --run` | Admin recovery: re-issues transfers whose Sepolia tx is verifiably reverted, on fresh nonces with the current gas limit |

### First ERC-20 release (Stage 2)

On 2026-11-08 the main contract was upgraded in place (no migration; existing plans still decode) and WETH was allowlisted. The vault held 0.015 ETH and 0.002 WETH; the reserve covered 4 vault transactions. Each heir received exact ETH and WETH shares, and the executor sent nonces 0–3 strictly in order after a 60 s outage: Tobi [ETH](https://sepolia.etherscan.io/tx/0x4faae1a9b300c26fc4fbbce8c159d1f498d5fb46cc04e0939e4f104d00c4713f) and [WETH](https://sepolia.etherscan.io/tx/0xeadc257a2ea44f5c9b378703bc1a1ecf2e4ba60176a2ae7f596b82e6d92a7fad), Amara [ETH](https://sepolia.etherscan.io/tx/0x924c1648dcee4cee9c1bffac6664799bf6314234976c4dfbbb74f31610e89fea) and [WETH](https://sepolia.etherscan.io/tx/0x2e66276191dba44a34858b339632af51a371092d49b459acace65ae195e89cb6). Its 0.009 ETH of unspent fee reserve was later recovered with owner vault withdrawal (D7).

### Partial failure and retry across two assets (Stage 2 exit criterion)

`e2e-partial`, 2026-11-08: a guardian reported 0.002 WETH when the vault held 0.0005. Amara's [ETH](https://sepolia.etherscan.io/tx/0xad0c2294c6180e148d42cd35c79a7fd147c2b56eef2d3798cb3a0d8a7da706b3) confirmed at nonce 0. The executor's simulation caught her WETH transfer (`WouldRevert`) before broadcast, so no fee was spent and nonce 1 stayed free. After a top-up she retried, and the contract re-signed WETH at nonce 1, which [confirmed](https://sepolia.etherscan.io/tx/0xfa9b1e06413893fba3e6622521e60fc495c303c006b2228375b35a6e120a08ed). The ETH transfer was never re-signed. The vault sent exactly two transactions, and Amara ended with exactly 0.0018 ETH + 0.0012 WETH.

### Delay signers and automatic release (Stage 2)

`e2e-auto`, 2026-11-08. A plan in Automatic mode with two delay signers (quorum 2, ≤ 1 minute per extension, ≤ 2 in total). After approval the signers extended the waiting period from 19:03:35 to 19:04:35 UTC with the reason code `checking-on-owner`. A heir's claim at 19:03:40 was refused (`E_NOT_ELIGIBLE`). When the extended period ended, the executor called `release` for each heir and the plan settled; the heirs' balances rose by exactly 0.03 and 0.02 NEAR without them signing anything.

### Release rules (Stage 2)

`e2e-rules`, 2026-11-08. The escrow of 0.05 NEAR + 7 yocto snapshotted as 0.026000…002 for Tobi (0.01 fixed + 40%) and 0.024000…005 for Amara (60% + the 1-yocto remainder), with nothing left in the plan. Neither heir claimed. A minute after claiming opened, a guardian moved Amara's share to her alternate and Tobi's (no alternate) to the fallback; both claimed and received exactly those amounts. The relayer sponsors claims by alternates and the fallback, and lets any plan participant move an unclaimed share without gas.

### First NEP-141 release (Stage 2)

`e2e-nep141`, 2026-11-08, on the upgraded main contract (no migration). The owner deposited 0.01 wNEAR with `ft_transfer_call`, and a deposit naming a plan that doesn't exist was refunded by the token. The owner withdrew 0.001. On release the remaining 0.009 wNEAR went 60/40 to two fresh implicit accounts (0.0054 and 0.0036); the contract registered each with `wrap.testnet` first, from 0.0025 NEAR it had reserved out of the plan's escrow. The first attempt found a gap: a token only pays registered accounts, and Behest itself wasn't registered. Listing a token now registers the contract with it.

### Clean reproduction (Stage 1 exit gate)

On 2026-11-08 a second deployment was built from scratch with no faucet: `bootstrap r1`, a source rebuild (same wasm sha256 `0e2c65ea…` as the main deployment), then `deploy-contract r1 --parent` (`deployments/r1.json`). Every NEAR scenario passed on it. So did `e2e-eth`: [Tobi, nonce 0](https://sepolia.etherscan.io/tx/0x5f1abb07f7b96c33cbc22676dc0b0cf959fba10519beff9d1875def09035de21) and [Amara, nonce 1](https://sepolia.etherscan.io/tx/0x020eccf530488d8991f0e8db5d91d23ba7176c1ae9230497fca055d46f743e85), each with its exact share. The run surfaced two tooling issues, both fixed: scenario owners were never reclaimed, and an error check crashed on BigInt fields.

### Found by the live runs: Sepolia gas rules changed

Since Glamsterdam, the first value transfer to an address that has never been used costs about 207k gas instead of 21k. Our first two-heir run used fresh wallets, so both transfers reverted with a fixed 21k limit, and the vault still paid the fees. The gas limit is now admin config (testnet: 250k), snapshotted per proposal. The executor refuses to broadcast when the signed limit is below the estimate, and `reissue_reverted_transfer` recovers mined reverts. The deployed contract was upgraded in place with `deploy-contract ekkr6 --migrate`; old plans convert lazily, and the reverted plan was recovered live (docs/stage0/03-signing-boundary.md).

### Vault remainder after a release (was an MVP limitation)

After a release, the vault keeps the unused network-fee reserve, the rounding remainder, and the ETH share of any heir without an ETH destination (D12, 04-policy-schema). Since Stage 2 the owner can withdraw it with `withdraw_vault` (D7) once the release has settled. Owner ETH withdrawal and an explicit residual rule are Stage 2 must-haves before any mainnet use.

## MVP delivery progress

1. [x] Policy schema, state machine, permissions, invariants, timer profiles
2. [x] Plan creation, check-in, proposal, guardian approval/rejection, cancellation, eligibility
3. [x] NEAR escrow and heir claim
4. [x] Exact Sepolia transaction construction and Chain Signatures authorization
5. [x] Executor: broadcast, idempotency, confirmation tracking, retry
6. [x] Fee cap and reserve enforcement on retry
7. [x] Gas relayer for heirs and guardians (pulled forward from Stage 2; D14)
8. [x] Role-based web app with policy and transaction previews
9. [x] Deploy scripts and live testnet e2e (all scenarios passing; first Sepolia release: [0x38e3…b323](https://sepolia.etherscan.io/tx/0x38e3a54ce63bba4b1a1940981bee6fe15e3f7c5cfac17b23ff14e9314381b323))

## Stage 2 progress (testnet alpha)

- [x] Allowlisted Sepolia ERC-20 (WETH): token address snapshotted per transfer, `transfer()` calldata signed by MPC, one fee reserve per vault transaction, executor calldata check (D15, threats 21–22)
- [x] Partial failure and retry across two assets without replaying the successful transfer (`e2e-partial`; executor `WouldRevert` pre-check)
- [x] Allowlisted NEP-141 token (wNEAR): `ft_transfer_call` deposits with refunds, owner `withdraw_ft`, 60/40 split, contract registers each heir with the token from reserved NEAR (D16, threat 24; live `e2e-nep141`)
- [ ] Bitcoin testnet adapter
- [x] Delay-signer quorum; automatic and hybrid release modes (D18–D19, threats 26–27; executor auto-release; live `e2e-auto`)
- [x] Fixed amounts with explicit remainder, named alternate, unclaimed-share fallback (D17, threat 25; live `e2e-rules`)
- [x] Owner ETH/token withdrawal from the vault (D7): `withdraw_vault`, `E_VAULT_BUSY`, executor-driven same-nonce cancel; live scenarios reclaim their unspent fee reserve
- [x] Testnet cost cut: fee cap 3 gwei, dust-sized test amounts, `recover-vaults` (recovered ≈0.021 ETH stranded by earlier runs)
