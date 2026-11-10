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
| `services/notifier/` | Notifier: watches plans (read-only) and delivers reminders and lifecycle notices per person by email, Telegram and signed webhooks |
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

## Notifications

`services/notifier` watches plans with view calls only (it holds no NEAR keys, so nothing it does or fails to do can change a plan) and delivers notices to each person over email, Telegram and webhooks. People choose channels on the web app's **Notifications** screen; contacts stay in the notifier's own SQLite database, never on-chain, and every change is a NEP-413 message signed by the account (a signature, not a transaction).

```sh
pnpm --filter @behest/notifier test
pnpm --filter @behest/notifier start          # reads the root .env; API on NOTIFY_PORT (8790)
NEXT_PUBLIC_NOTIFIER_URL=http://localhost:8790 pnpm --filter @behest/web dev
```

What it sends, and to whom: check-in reminders at 75% and 95% of the window (owner); owner unreachable (owner, guardians); release proposed, guardian votes (owner, guardians; heirs too for follow-up rounds); approved with the cancel deadline, delay requested / extended (owner, guardians, heirs, delay signers); rejected, cancelled, settled; ready to receive, worded by release mode (heirs); each transfer's arrival with an Etherscan / mempool.space / NEAR Blocks link (that heir); failures, proven reverts re-issued, unclaimed shares moved (that heir, guardians); owner vault withdrawals. Wording never says more than the contract knows: "hasn't checked in", "unreachable".

Plans watched: every open release, every subscriber's own plan, plans a subscriber is part of and chose to follow, and `NOTIFY_OWNERS`. A notice's key is recorded once, so restarts never repeat one; each (notice, person, channel) delivery retries with exponential backoff independently and gives up after `NOTIFY_MAX_ATTEMPTS`. `NOTIFY_WEBHOOK_URL` still receives every notice as an operator feed. An older `.notifier-state.json` is imported on first start.

**Email** (any SMTP provider). Set `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS or 465 with `SMTP_SECURE=1`), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (e.g. `Behest <notify@your-domain>`), or one `SMTP_URL`. For Resend: host `smtp.resend.com`, port 465, user `resend`, password = API key; Postmark: `smtp.postmarkapp.com`, 587, server token as user and password; SES: the region's SMTP endpoint and SMTP credentials. The From domain needs SPF/DKIM set up with the provider. Set `NOTIFY_PUBLIC_URL` to the notifier's public https URL (confirmation and unsubscribe links) and `NOTIFY_APP_URL` to the web app.

**Telegram.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a username ending in `bot`, and put the token in `TELEGRAM_BOT_TOKEN` and the username (no @) in `TELEGRAM_BOT_USERNAME`. Optionally `/setcommands` with `status - what this chat receives` and `stop - unlink this chat`. The notifier long-polls `getUpdates`, so no public URL is needed; run one instance per bot.

**Webhooks.** Any https URL (Slack and Discord incoming webhooks work as they are). Each POST carries `X-Behest-Event`, `X-Behest-Delivery` (de-duplicate on it), `X-Behest-Timestamp` and `X-Behest-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`; the secret is shown once when the webhook is added. The body has `kind`, `owner`, `account`, `proposal_id`, `transfer_index`, `asset`, `amount`, `tx_hash`, `explorer_url`, `links`, `subject`, plus `text` (Slack) and `content` (Discord). Private, loopback and link-local addresses are refused; `NOTIFY_WEBHOOK_ALLOW_INSECURE=1` allows http and local hosts for development only.

All variables are listed in `.env.example`. Threats 32–38 cover the new surface.

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
| `e2e-auto` | Delay signers and automatic release: two delay signers extend an approved release's waiting period by one minute (a heir's claim inside it is refused), then the executor starts Tobi's transfer by itself (he signs nothing and receives exactly his share) while Amara's per-heir Claim override leaves hers until she claims |
| `e2e-rules` | Release rules: 0.05 NEAR + 7 yocto with a 0.01 NEAR fixed amount for Tobi, the rest 60/40, the remainder to Amara (every yocto distributed). Nobody claims; after the 1-minute claim window Amara's share moves to her named alternate and Tobi's to the fallback, and both claim it |
| `e2e-nep141` | NEP-141: the owner wraps NEAR and deposits wNEAR (a deposit for an unknown plan is refunded), withdraws part of it, then the release splits it 60/40 to two fresh accounts the contract registers with the token first; heirs hold exactly their shares and the registration reserve is spent exactly |
| `e2e-btc` | Bitcoin testnet4 (D20): a plan registers an MPC-derived P2WPKH vault; the funder sends it tBTC; the owner withdraws part of it (MPC-signed, executor-broadcast, change back to the vault); guardians propose with the vault's coin; Amara (Taproot address) and Tobi (P2WPKH) claim, their payouts are chained (Tobi's spends Amara's change before either is mined), each address receives exactly its share and the plan settles. Needs ≥ 32k sats on the `btc-funder` address; waits for 2–3 blocks |
| `e2e-followup` | Follow-up rounds (D21): a release with Tobi's 0.01 NEAR fixed amount settles; a friend deposits 0.02 NEAR afterwards; Amara (an heir) proposes a follow-up round, guardians approve, both heirs receive a plain 60/40 split (the fixed amount isn't paid twice); the history holds both rounds and the owner can check in again |
| `e2e-revert` | Proven reverts (D22): a transfer signed with too little gas reverts on Sepolia; a re-issue on the admin's word is refused; once the Ethereum light client on NEAR finalizes the block, a proof of the revert is checked by the contract and the executor re-issues under the next nonce; the heir receives exactly her share |
| `e2e-partial` | Partial failure across two assets: a guardian over-reports the vault's WETH, Amara's ETH confirms, and her WETH is caught before broadcast (`WouldRevert`: no fee spent, nonce kept). After a top-up she retries; WETH is re-signed at the same nonce and confirms, the confirmed ETH transfer is never touched, and she ends with exactly one share of each |
| `recover-vaults <owner>…` | Withdraws what earlier runs left in plan vaults back to the funder via D7 (re-creates deleted scenario owner accounts by name) |
| `reissue <owner> --run` | Recovery: proves each reverted Sepolia transfer against the Ethereum light client (D22), then re-issues it on a fresh nonce with the current gas limit |

### First ERC-20 release (Stage 2)

On 2026-11-08 the main contract was upgraded in place (no migration; existing plans still decode) and WETH was allowlisted. The vault held 0.015 ETH and 0.002 WETH; the reserve covered 4 vault transactions. Each heir received exact ETH and WETH shares, and the executor sent nonces 0–3 strictly in order after a 60 s outage: Tobi [ETH](https://sepolia.etherscan.io/tx/0x4faae1a9b300c26fc4fbbce8c159d1f498d5fb46cc04e0939e4f104d00c4713f) and [WETH](https://sepolia.etherscan.io/tx/0xeadc257a2ea44f5c9b378703bc1a1ecf2e4ba60176a2ae7f596b82e6d92a7fad), Amara [ETH](https://sepolia.etherscan.io/tx/0x924c1648dcee4cee9c1bffac6664799bf6314234976c4dfbbb74f31610e89fea) and [WETH](https://sepolia.etherscan.io/tx/0x2e66276191dba44a34858b339632af51a371092d49b459acace65ae195e89cb6). Its 0.009 ETH of unspent fee reserve was later recovered with owner vault withdrawal (D7).

### Partial failure and retry across two assets (Stage 2 exit criterion)

`e2e-partial`, 2026-11-08: a guardian reported 0.002 WETH when the vault held 0.0005. Amara's [ETH](https://sepolia.etherscan.io/tx/0xad0c2294c6180e148d42cd35c79a7fd147c2b56eef2d3798cb3a0d8a7da706b3) confirmed at nonce 0. The executor's simulation caught her WETH transfer (`WouldRevert`) before broadcast, so no fee was spent and nonce 1 stayed free. After a top-up she retried, and the contract re-signed WETH at nonce 1, which [confirmed](https://sepolia.etherscan.io/tx/0xfa9b1e06413893fba3e6622521e60fc495c303c006b2228375b35a6e120a08ed). The ETH transfer was never re-signed. The vault sent exactly two transactions, and Amara ended with exactly 0.0018 ETH + 0.0012 WETH.

### Delay signers and automatic release (Stage 2)

`e2e-auto`, 2026-11-08. A plan in Automatic mode with two delay signers (quorum 2, ≤ 1 minute per extension, ≤ 2 in total). After approval the signers extended the waiting period from 19:03:35 to 19:04:35 UTC with the reason code `checking-on-owner`. A heir's claim at 19:03:40 was refused (`E_NOT_ELIGIBLE`). When the extended period ended, the executor called `release` for each heir and the plan settled; the heirs' balances rose by exactly 0.03 and 0.02 NEAR without them signing anything. A rerun at 19:15 UTC gave Amara a per-heir override back to Claim: the executor released only Tobi (exactly 0.02 NEAR, no signature from him), left Amara's share pending through further passes, and the plan settled when she claimed.

### Release rules (Stage 2)

`e2e-rules`, 2026-11-08. The escrow of 0.05 NEAR + 7 yocto snapshotted as 0.026000…002 for Tobi (0.01 fixed + 40%) and 0.024000…005 for Amara (60% + the 1-yocto remainder), with nothing left in the plan. Neither heir claimed. A minute after claiming opened, a guardian moved Amara's share to her alternate and Tobi's (no alternate) to the fallback; both claimed and received exactly those amounts. The relayer sponsors claims by alternates and the fallback, and lets any plan participant move an unclaimed share without gas.

### First Bitcoin release (Stage 2)

`e2e-btc`, 2026-11-09, on testnet4. The funder sent 30,000 sats to the plan's MPC-derived vault ([9c99…0cd6](https://blockstream.info/testnet4/tx/9c9958fe97fa96e1811201a292ce3a28b116716a7d5dd1413fa02f1693fc0cd6)). The owner withdrew 5,000 sats; the contract built the transaction, the MPC network signed it, and 24,718 sats of change came back to the vault. Guardians proposed with that coin: 1,530 sats reserved for fees at the 5 sat/vB cap, then 13,912 sats for Amara (a Taproot address) and 9,275 for Tobi (P2WPKH). Tobi's payout spends Amara's change, so both were signed before either was mined. testnet4 then mined only empty blocks for hours; Tobi's payout was reported Stuck and re-signed at 3 sat/vB, and both payouts confirmed in block 159,964 ([Amara](https://blockstream.info/testnet4/tx/bd82083dec314cc1aa7e6e1c808aadb631da580909b67a41b17ce546a5d73db1), [Tobi](https://blockstream.info/testnet4/tx/5ebccc11867e077a47d7119f64711db428756b738ddb383172d5acdeb5164e39)). The run found a bug: a payout reported Stuck that the network took anyway couldn't be reported again, leaving the plan unsettled. The contract now accepts it and the executor checks for it before re-signing.

### Proven revert (Stage 2)

`e2e-revert`, 2026-11-09. Amara's 0.000137 ETH transfer was signed with a 21k gas limit and sent to a never-used address, so it reverted when mined ([0xb421…4311](https://sepolia.etherscan.io/tx/0xb421ee924c92d4e4f2f865042588e42be11e272c92765637bd6d7d3e4b724311)). A second executor that was running at the time refused to broadcast the same transfer and recorded it as never sent ("GasLimitTooLow"). That left the contract believing nonce 0 unused, which no report could fix. The admin's re-issue was refused. About 25 minutes later the Ethereum light client on NEAR (`client-eth2.sepolia.testnet`) had finalized the block. Amara, an heir, submitted the header and Merkle-Patricia proofs; the contract verified them and corrected the record to "Reverted". The executor re-issued under nonce 1 with 250k gas ([0xc4ed…80cb](https://sepolia.etherscan.io/tx/0xc4eda334bc1690c70228fa606ac8798a5ac875a47a7113e3474b0336befd80cb)), and Amara received exactly her share. Proofs need a node that serves raw transactions and block receipts (`SEPOLIA_PROOF_RPC_URL`, publicnode by default); some hosted providers don't.

### Follow-up rounds (Stage 2)

`e2e-followup`, 2026-11-09. A release split 0.05 NEAR as 0.026 to Tobi (0.01 fixed + 40%) and 0.024 to Amara, and settled. Afterwards a friend deposited 0.02 NEAR; the owner never checked in, so Amara herself proposed a follow-up round. Two guardians approved, and after the waiting period the heirs received 0.012 and 0.008: a plain 60/40 split, because Tobi's fixed amount was already paid. Both rounds are in the plan's history, and the owner could check in again afterwards (before D21 a settled release blocked check-ins and deposits for good).

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
- [x] Bitcoin testnet adapter: MPC-derived P2WPKH vault, owner withdrawal, fee-reserved 60/40 split, chained payouts to bech32 and bech32m heirs, RBF fee bumps (D20, threats 28–31; live `e2e-btc`)
- [x] Proven Sepolia outcomes: re-issuing a reverted transfer needs a Merkle-Patricia receipt proof checked against the Ethereum light client on NEAR; anyone may prove or re-issue, and the executor does it once the block is final (D22, threat 20; live `e2e-revert`)
- [x] Per-chain fee reserves and live quotes: the likely Sepolia and Bitcoin fees shown next to each worst-case reserve when proposing, claiming and withdrawing (D6)
- [x] Delay-signer quorum; automatic and hybrid release modes per plan, heir and asset group (D18–D19, threats 26–27; executor auto-release; live `e2e-auto`)
- [x] Fixed amounts with explicit remainder, named alternate, unclaimed-share fallback (D17, threat 25; live `e2e-rules`)
- [x] Owner ETH/token withdrawal from the vault (D7): `withdraw_vault`, `E_VAULT_BUSY`, executor-driven same-nonce cancel; live scenarios reclaim their unspent fee reserve
- [x] Follow-up release rounds: settled releases archived, heirs can start a round for what is left, fixed amounts paid once, reported balances recorded and checked against the live vaults before voting; rejection returns NEP-141 shares; owners can check in after a release (D21, threat 4; live `e2e-followup`)
- [x] Notifications per person by email, Telegram and signed webhooks, with NEP-413-signed contact management, retries per channel and every Stage 2 event (D11, threats 32–38; live run against `behest-ekkr6.testnet`)
- [x] Testnet cost cut: fee cap 3 gwei, dust-sized test amounts, `recover-vaults` (recovered ≈0.021 ETH stranded by earlier runs)
