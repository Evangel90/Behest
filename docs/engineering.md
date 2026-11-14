# Behest: engineering notes

The full technical reference: how to run each component, every configuration switch, the live testnet runs with their transaction links, and delivery progress. For the overview, start with the [README](../README.md). Design decisions (D1–D34) and the threat model are in [spec/](spec/).

## Repository layout

| Path | What |
|---|---|
| `docs/spec/` | Spec: state machine, permissions, signing boundary, schema, threat model, decisions |
| `contracts/behest/` | Rust NEAR contract (near-sdk 5.x) |
| `services/executor/` | TypeScript executor: broadcasts contract-signed Sepolia transfers, tracks confirmations, retries |
| `apps/web/` | Next.js web app: landing, owner dashboard and setup, guardian approval, mobile heir claim, public inspector, “Try as…” personas |
| `services/notifier/` | Notifier: watches plans (read-only) and delivers reminders and lifecycle notices per person by email, Telegram and signed webhooks |
| `services/relayer/` | Gas relayer: pays NEAR gas (NEP-366 meta-transactions) so heirs, guardians and owner check-ins need no NEAR |
| `tools/testnet/` | Testnet deploy script and live end-to-end scenarios |
| `deployments/testnet.json` | Current testnet deployment (public account IDs, wasm hash) |

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
- **Email** (D34). A 6-digit code to the inbox signs in; the account is the Ethereum, NEAR and Bitcoin wallets Privy keeps for that address. To Behest it is an Ethereum wallet: every action is a signed readable message the relayer submits. On when `PRIVY_APP_ID` is set (and `PRIVY_APP_SECRET` for the notifier).
- **Email, Google or passkey** through NEAR Auth. Shown only when email sign-in is off, and switched off until `NEXT_PUBLIC_NEAR_AUTH_CLIENT_ID` is set, because NEAR has to issue that client ID.
- **Try as…** (testnet only). `/api/demo` creates six funded accounts under `DEMO_FUNDER_ACCOUNT_ID` from public keys the browser generates. The private keys never leave the browser. Rate limits: 3 sandboxes per hour per IP and 30 per day.

Heirs see the paper theme in plain language; hashes appear only under "Technical details". Anyone can open `/plan/<owner>?view=inspect`.

### DAOs and multisigs (D26)

A SputnikDAO v2 account (the DAOs Trezu manages) can own a plan, guard one, inherit or sign for more time: Behest checks the calling account, and a DAO calls through a proposal that runs when its council approves.

- In the app, a council member signs in with a NEAR wallet and chooses **Act as a DAO** (sign-in dialog or account menu), then names the DAO. The app reads `get_policy` to show the member's roles, the bond and how many votes pass a proposal. From then on every action is an `add_proposal` with the FunctionCall kind, the bond attached and a plain-words description (Trezu shows it); several owner calls go in one proposal. Calls to other contracts work too: the DAO pays its tier with USDC `ft_transfer_call`. The plan screen lists the DAO's open Behest proposals with **Approve** and **Reject** and links to Trezu (mainnet).
- DAO-owned plans attach their own storage deposit: the free storage pool (D24) only covers transactions Behest's relayer signs, and a DAO's call is signed by the council member who casts the deciding vote.
- **Check-in delegates** (Standard tier): up to 10 accounts that may check in for the owner and do nothing else. A DAO's own check-in takes a vote; a council member named as delegate checks in with one signature (sponsored by the relayer). Delegates can't check in while a release is open, so they can't cancel one.
- The wizard warns when the check-in interval isn't well above the DAO's voting window and when a DAO heir would have to claim (use Automatic or Hybrid release). On **Notifications**, a council member can send all of the DAO's notices to every council member.

```sh
pnpm --filter @behest/testnet e2e-dao   # live: SputnikDAO owner, guardian and heir from sputnikv2.testnet
```

### Receiving through NEAR Intents (D27)

An owner can choose, per heir (and for named alternates and the fallback), **Receive through NEAR Intents** (Standard tier). That person's NEAR and NEAR-token shares are then paid into their NEAR Intents account instead of their wallet: NEAR is wrapped and sent to the Intents verifier in one atomic receipt, tokens go straight from escrow. If the verifier hands back any part of a payment, the transfer counts as failed and a retry sends only what is still unpaid.

- The heir screen shows what the heir holds in Intents and lets them withdraw it; on mainnet they can also swap it to almost any asset on almost any chain through 1Click, signing with their NEAR wallet (NEP-413) or Ethereum wallet (ERC-191). Behest takes no fee on this.
- ETH and Bitcoin: on mainnet the app can fill in a NEAR Intents bridge deposit address as the heir's Ethereum or Bitcoin destination. Testnet has no bridge, so the app only explains it.
- On testnet the verifier is a mock (`contracts/mock-intents`, deployed as `behest-<suffix>-intents.testnet`) with deposits, balances, configurable refunds and withdrawals. **The real `intents.near`, the bridge and 1Click are untested until a later mainnet step.**

```sh
pnpm --filter @behest/testnet e2e-intents   # live: failing, half-refunding and keeping (mock) verifiers
```

### Edit notice and guardian recovery (D28, D29)

- **Edit notice (cooling-off).** An owner can set a notice of 1–90 days (minutes on demo builds). Changes to heirs, shares, destinations, guardians, quorum, release rules, release mode and standbys then wait out the notice before taking effect. Guardians and heirs are told (the notifier can't switch this notice off), and the owner can cancel until it ends. When the notice ends, anyone can apply the change. Timers, check-in delegates and withdrawals stay instant. Lowering or removing the notice also waits.
- **Standby guardians.** Up to 5, in order, named by the owner. If a guardian resigns, the next standby takes the seat at once. With availability checks on, a guardian who hasn't confirmed (or voted) within the window can be replaced by anyone calling a standby. The swap lands after a notice, and the guardian stops it just by confirming.
- **Rotation and resignation.** A guardian can move its seat to a new account after the swap notice; the owner can cancel. A guardian can step down; with no standby left, the seat stays empty.
- **The quorum never drops.** When too few guardians are available, the plan says so on every screen and in notifications, and a release waits for a standby, a guardian or the owner.

```sh
pnpm --filter @behest/testnet e2e-recovery   # live: queued, cancelled and applied edits; standby swap, rotation, resignation
```

### Presets and the plan in plain words (D32)

- **Presets.** A new plan starts from Careful, Balanced or Quick, or from scratch. Each fills in the timers, 2-of-3 guardians, an edit notice and availability checks, and explains every default. Nothing is locked: the wizard shows which values you changed, and everything stays editable on the plan page. Presets stay on the Free tier.
- **In plain words.** Every plan view has a module-by-module summary (Check-ins, Activation, Guardians, Waiting period, Heirs and allocations, Claims, Recovery) with what each rule means and warnings for risky combinations. It's part of the review step and opens by itself while a release is under way.

### Private heirs (D33)

- **Sealed plans.** An owner can keep heirs private. On-chain there's only a SHA-256 fingerprint of each heir's recovery record (account, share, NEAR, Ethereum and Bitcoin destinations, a random salt). Fingerprints are computed in the browser; nothing about the heirs is sent to an RPC node. Standard tier or above.
- **Reveal before release.** Once the owner is overdue, each heir (or anyone holding their record) reveals it. A release starts once every heir is revealed or the owner's reveal window has passed. A share nobody revealed is split among the revealed heirs, or goes to the fallback. If the owner checks in or cancels, the plan is sealed again. What was revealed stays in the public record, and so do payments once made.
- **Records.** The owner downloads one record per heir. Each heir's printed packet includes it as text and a QR code. Optionally, Behest keeps an encrypted copy (AES-256-GCM, row ids are keyed hashes) and hands each heir its own record only once the plan is overdue. Behest itself could read the copy, so it's the owner's choice.

```sh
pnpm --filter @behest/testnet e2e-private   # live: sealed heirs, refused reveals, reseal on check-in, unrevealed share redistributed
```

### People named by email (D34)

- **Naming.** In the setup wizard every guardian and heir is "an email address or a NEAR account". For an address, the notifier asks Privy for the wallets kept for it (creating them if new) and returns the account the plan will name; ETH, NEAR and BTC default to those wallets, and the owner can enter other destinations. Emails stay in the notifier's database, never on-chain. People named by account can be given an email for notices only.
- **Telling them.** Guardians get one email when the plan on-chain first names them; heirs only if the owner chooses "now", otherwise they first hear when a release is approved. The owner sets the name those emails use. An address an owner supplied only hears about that owner's plan, and unsubscribing sticks.
- **Claiming.** The person opens the link, signs in with the same address (a code to the inbox, no wallet) and is the account the plan names: a guardian proposes and approves, a heir receives. The app finds the plans that name them.
- **Proving addresses.** Someone signed in by email proves the Ethereum and Bitcoin addresses kept for them in one click each (D30): the Ethereum one with a signed message, the Bitcoin one with a BIP-137 signed message whose recovery header the app rebuilds, since that key only signs hashes.
- **Moving it on.** "Your account" shows what arrived (NEAR and NEAR tokens, ETH and ERC-20s, BTC) with a send form for each. Ethereum transactions are signed whole by the service; NEAR and Bitcoin transactions are built and checked in the browser and only their hash is signed.
- **What it depends on.** The person's inbox and Privy. The contract still decides when and how much; neither Privy nor Behest can start a release or redirect a share. A heir with their own wallet depends on neither.

Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` (dashboard.privy.io; email login on). The web app only ever sees the app id.

### Destination proofs and requests (D30, D31)

- **Proof of control.** A heir, alternate or fallback proves it controls each registered address: a NEAR account by calling from it, an Ethereum address with a `personal_sign` signature, a Bitcoin `tb1q…` address with a signed message (Electrum, Sparrow, Bitcoin Core). The signed text names the contract, owner, recipient, chain and address. A proof only counts for that exact address, and it never blocks a release. Taproot (`tb1p…`) proofs aren't supported yet.
- **New addresses while the owner is active.** A recipient asks for a new address on one network, optionally proving it at once. Only the owner can approve; approving is an ordinary edit, so the edit notice applies. Requests close once the plan is overdue or a release is open.
- **Owner account recovery** is guidance, not a contract path: a second full-access key, check-in delegates, the edit notice, or a DAO owner. The plan follows the owner's account.

```sh
pnpm --filter @behest/testnet e2e-destinations   # live: NEAR, EIP-191 and BIP-137 proofs; rejected and approved requests
```

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

**Email over HTTPS (Brevo).** Some hosts block outgoing SMTP ports (Railway below its Pro plan, for one): sends then time out. Set `BREVO_API_KEY` and the notifier sends through Brevo's transactional API instead of SMTP, from `EMAIL_FROM` (or `SMTP_FROM`). In Brevo: verify that sender, create the key under SMTP & API, and switch off the authorised-IPs check (or list the host's addresses), or Brevo answers 401. Brevo accepts only non-standard custom headers and adds its own `List-Unsubscribe`, so notices sent this way carry the unsubscribe link in the body only.

**NEAR RPCs.** The notifier reads through `NEAR_RPC_URL` and, when that one fails or rate-limits, the comma-separated `NEAR_RPC_FALLBACK_URLS` in turn, staying on the one that answers. On testnet the fallbacks default to public endpoints; elsewhere set them yourself.

**Telegram.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a username ending in `bot`, and put the token in `TELEGRAM_BOT_TOKEN` and the username (no @) in `TELEGRAM_BOT_USERNAME`. Optionally `/setcommands` with `status - what this chat receives` and `stop - unlink this chat`. The notifier long-polls `getUpdates`, so no public URL is needed; run one instance per bot.

**Webhooks.** Any https URL (Slack and Discord incoming webhooks work as they are). Each POST carries `X-Behest-Event`, `X-Behest-Delivery` (de-duplicate on it), `X-Behest-Timestamp` and `X-Behest-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`; the secret is shown once when the webhook is added. The body has `kind`, `owner`, `account`, `proposal_id`, `transfer_index`, `asset`, `amount`, `tx_hash`, `explorer_url`, `links`, `subject`, plus `text` (Slack) and `content` (Discord). Private, loopback and link-local addresses are refused; `NOTIFY_WEBHOOK_ALLOW_INSECURE=1` allows http and local hosts for development only.

**DAOs (D26).** A DAO can't sign in or read email, so any council member can switch on council notices for it (`PUT /v1/council`, a signed `council.set`): every notice addressed to the DAO then also goes to each current council member's own contacts. Members are read from the DAO's `get_policy` (cached ten minutes), so people who leave the council stop receiving them.

All variables are listed in `.env.example`. Threats 32–38 cover the new surface.

## Gas relayer

```sh
pnpm --filter @behest/relayer test
pnpm --filter @behest/relayer start     # needs RELAYER_ACCOUNT_ID / RELAYER_PRIVATE_KEY in .env
```

Clients sign a delegate action and `POST /relay {"signed_delegate": "<base64 borsh>"}`; `@behest/relayer/client` exports `sponsoredCall()` for this. The relayer only pays gas. It sponsors a single, zero-deposit call to the Behest contract, limited to the allowlist in `services/relayer/src/methods.ts` (heir, guardian, delay-signer and owner calls, plus owner configuration with no deposit under D24), and only when the sender actually holds that role in the plan. Rate limits apply per sender and globally. Deposits are never sponsored, and NEAR owners pay for their own withdrawals. The contract still authorizes everything, so a compromised relayer can waste its own NEAR but cannot move funds.

### EVM wallets and sponsored storage (D23, D24)

EVM wallets act through signatures the contract verifies itself. The wallet signs a readable `personal_sign` message (`Behest signed action`, a summary line, a blank line, then `{"contract","network","actor","method","args","nonce","deadline_ms"}`; build it with `signedActionMessage` from `@behest/relayer/evm`), and `POST /evm-call {"message","signature"}` submits it as `evm_call`, which runs one allowlisted method as the wallet's eth-implicit account `0x…`. `GET /evm-nonce?account=0x…` returns the nonce to sign (also the contract view `get_evm_nonce {account}`). Responses match `/relay`: `{tx_hash, status, failure?, result?}`, where `result` is the method's return value. Owner configuration (`set_plan`, rules, options, Bitcoin destinations) sent with no deposit through the relayer, by meta-transaction or `evm_call`, is paid from the contract's sponsor pool within a per-owner allowance and a daily cap on new plans (`get_sponsorship {owner}`). The notifier accepts `{scheme: "eip191", accountId: "0x…", message, signature}` envelopes next to NEP-413. Set `NEAR_VIEW_RPC_URL` to send the relayer's policy reads to another RPC than its transactions.

```sh
pnpm --filter @behest/testnet gen-evm-vectors   # regenerate the contract's signature test vectors (viem)
pnpm --filter @behest/testnet e2e-evm           # live: a plan run entirely by throwaway EVM wallets
```

### Plan tiers (D25)

A plan with one heir and NEAR only is free. **Standard** ($49, once) adds up to 5 heirs and guardians, Ethereum and Bitcoin destinations, NEP-141 escrow and release rules; **Complete** ($149) adds automatic and hybrid release, per-heir modes and delay signers. Prices are an admin schedule in the fee token (`get_tier_config`). Anyone pays for any owner with `ft_transfer_call` of the fee token to Behest and `msg = {"pay_tier":"<owner>"}`. Payments add up as credit, so an upgrade costs only the difference. Tiers limit what an owner can save (`E_TIER_REQUIRED`), never a check-in, proposal or release. Fee revenue sits in a treasury apart from escrow, network-fee reserves and the sponsor pool (`get_treasury`; the admin pays it out with `withdraw_treasury`).

- Testnet: `deploy-contract` deploys a mock USDC with a public faucet (`behest-<suffix>-usdc.testnet`, `mint {account_id, amount}` ≤ 500 USDC) and turns tiers on. The app pays with test USDC; owners without NEAR (Ethereum wallets) are paid for by `/api/demo/usdc` from `DEMO_FUNDER_ACCOUNT_ID`.
- Mainnet: set `USDC_TOKEN_ID` to Circle's USDC on NEAR. The app's "Any asset" option quotes NEAR Intents' 1Click API, which swaps a deposit on almost any chain into USDC and pays Behest with the owner in `customRecipientMsg`.
- `/pay/<owner>` lets a relative pay; the owner screen shows the tier and keeps the service fee, storage and network fees on separate lines; `/inspect` shows the treasury.

```sh
pnpm --filter @behest/testnet e2e-tiers   # live: free plan, refusals, part payments by a relative, upgrades, treasury payout
```

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
| `e2e-dao` | DAOs (D26), made by `sputnikv2.testnet`: a fresh owner DAO pays its Complete tier from its own USDC and creates its plan (`set_plan` + `deposit` + Automatic release + a check-in delegate) in one proposal each, approved by both council members; the delegate checks in with one signature while a stranger is refused; the deadline passes, guardian 3 proposes and the guardian DAO approves through its own proposal; the delegate can't check in once the release is open; the executor pays the heir DAO the whole escrow with nobody there signing |
| `e2e-intents` | NEAR Intents delivery (D27) against the mock verifier: a fresh owner pays Standard and opts Amara in (Tobi stays on his wallet); with the verifier failing, Amara's NEAR and wNEAR transfers fail with the deposit refunded and nothing counted as paid; with it handing back half, both fail (`IntentsPartlyRefunded`), half is recorded as delivered and the refunded wNEAR is unwrapped into escrow; with it keeping everything, the retries send only the unpaid halves and confirm. Amara's Intents balance grows by exactly her two shares and Behest's wNEAR falls by exactly the escrowed share. Tobi is paid to his wallet; Amara withdraws wNEAR from Intents |
| `e2e-tiers` | Plan tiers (D25): a fresh owner saves a free one-heir plan; a second heir with an Ethereum destination is refused and a wNEAR deposit refunded; a relative pays 20 USDC (credit, still Free) and a dust payment for a stranger is refunded; the owner pays the remaining 29 for Standard and saves the two-heir plan; automatic release is refused until the 100 USDC still missing for Complete is paid; the treasury collected exactly 149 and the admin pays 1 out |
| `topup <account> [rounds] [--pool <NEAR>]` | Refills a testnet account from NEAR's account-creation faucet (≈10 NEAR a round: a throwaway account is created, then deleted into the target), optionally paying NEAR into the D24 sponsor pool; keys are kept in the keychain until swept, so an interrupted run loses nothing |
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

### First release run by EVM wallets (D23, D24)

`e2e-evm`, 2026-11-10, on the upgraded main contract (no migration; wasm `fa5568e6…`). Five throwaway secp256k1 keys were the owner, both guardians and both heirs, each acting as its eth-implicit account and never holding NEAR. The owner created the plan by signature with no deposit ([F1pa…GiH](https://testnet.nearblocks.io/txns/F1pab7GMX3wwkf7omm52Lsivv6d7zxhqPKXSCDCabGiH)); the sponsor pool paid its 0.00605 NEAR of storage, charged to the owner's 0.1 NEAR allowance. A NEAR account deposited 0.2 NEAR of escrow for it. The owner checked in by signature; replaying that signature was refused by the relayer and, sent straight to the contract, by `E_EVM_NONCE`. A guardian's signed `claim` was refused (not a heir) and a signed `deposit` too (never allowed). Once overdue, the guardians proposed ([Gefc…cs](https://testnet.nearblocks.io/txns/Gefcivntzn8rTeXwvTsS8rvQ1RmZpnfa3wTzss3Bq1cs)) and approved ([3fSe…b7](https://testnet.nearblocks.io/txns/3fSeyHwjavnhaT3wFZJZXYRgRxkBWsDG4LQ9asF5Hbb7)) by signature; after the waiting period both heirs claimed ([HaWd…p](https://testnet.nearblocks.io/txns/HaWdzMYxrcm71qjLcPKGGggjPYDqgXyvZsCy9TgHZu2p), [Fwbc…co](https://testnet.nearblocks.io/txns/Fwbcya4EFbDkm5F6psy6m9DRVmD55ThjVpHTxifLUwco)). The payouts created both 0x accounts with exactly 0.12 and 0.08 NEAR and the Ethereum wallet contract installed. The relayer paid every transaction. The first runs hit fastnear's per-IP rate limit, so the relayer now reads through `NEAR_VIEW_RPC_URL` and retries rate-limited sends.

### First NEP-141 release (Stage 2)

`e2e-nep141`, 2026-11-08, on the upgraded main contract (no migration). The owner deposited 0.01 wNEAR with `ft_transfer_call`, and a deposit naming a plan that doesn't exist was refunded by the token. The owner withdrew 0.001. On release the remaining 0.009 wNEAR went 60/40 to two fresh implicit accounts (0.0054 and 0.0036); the contract registered each with `wrap.testnet` first, from 0.0025 NEAR it had reserved out of the plan's escrow. The first attempt found a gap: a token only pays registered accounts, and Behest itself wasn't registered. Listing a token now registers the contract with it.

### First tier payments (D25)

`e2e-tiers`, 2026-11-11, after upgrading `behest-ekkr6.testnet` in place (no migration; wasm `b908c3c8…`) and deploying the mock USDC at `behest-ekkr6-usdc.testnet`. A fresh owner saved a one-heir NEAR plan for free. Adding a second heir with an Ethereum destination was refused with `E_TIER_REQUIRED`, and a 0.005 wNEAR deposit was refunded by the token. A relative paid 20 USDC: the plan stayed Free with 29 due for Standard. A 0.5 USDC first payment for an account Behest had never seen was refunded. The owner paid 29 and the two-heir plan saved, with the wNEAR now accepted into escrow. Automatic release was refused until the owner paid the 100 USDC still missing for Complete, after which it saved. The treasury showed exactly 149 USDC from 3 payments; the admin paid 1 USDC out, and the owner's attempt was refused. Every existing scenario now pays its owner's tier the same way before creating a plan.

### DAOs in every role (D26)

`e2e-dao`, 2026-11-11, after upgrading `behest-ekkr6.testnet` in place (wasm `1550b049…`; the D25 tier schedule read back through the versioned-key fallback). The guardian DAO `bg-ekkr6.sputnikv2.testnet` (council: guardians 1 and 2) and the heir DAO `bh-ekkr6.sputnikv2.testnet` (council: the two heirs) were created once; the owner DAO `bomwclusm5.sputnikv2.testnet` (council: the owner account and guardian 3) was new. Proposal #0 paid Complete from the DAO's own 149 test USDC; #1 saved the plan, funded 0.3 NEAR, set Automatic release and named guardian 3 as check-in delegate. The delegate checked in alone; a stranger got `E_NOT_DELEGATE` and the delegate's withdrawal `E_NO_PLAN`. After the deadline guardian 3 proposed and the guardian DAO's proposal #0 approved; the delegate's check-in was then refused with `E_PROPOSAL_OPEN`. The executor released and the heir DAO received exactly 0.3 NEAR. In the app (headless Chrome, persona = guardian 3), acting as the owner DAO: a check-in became proposal #2 and Approve recorded one of two votes; the second vote ran it. Back as guardian 3, "Check in for …" went through the relayer as a sponsored `check_in {owner}`.

### NEAR Intents delivery (D27)

`e2e-intents`, 2026-11-11, after upgrading `behest-ekkr6.testnet` in place (wasm `2e88fd81…`) and deploying the mock verifier at `behest-ekkr6-intents.testnet` (`set_intents_config` registered Behest and the verifier with `wrap.testnet`). A fresh owner paid Standard, opted Amara in and escrowed 0.05 NEAR and 0.01 wNEAR; Amara's shares were 0.0285 NEAR and 0.00525 wNEAR. With the mock failing every deposit the token refunded both payments: both transfers `Failed` (`IntentsRefunded`), nothing credited, `paid` 0. With it handing back half: both `Failed` (`IntentsPartlyRefunded`), `paid` exactly half, the refunded wNEAR unwrapped (`wrapped` back to 0). With it keeping everything, the retries sent only the halves and confirmed; Amara's Intents balance grew by exactly 0.03375 and Behest's wNEAR fell by exactly 0.00525. Tobi was paid to his wallet, and Amara withdrew 0.00525 wNEAR from the mock to her wallet (after registering with the token: a withdrawal is a plain `ft_transfer`). In the app (headless Chrome, persona = Amara) the heir screen showed her Intents balance from `mt_batch_balance_of` and a 0.001 wNEAR withdrawal went through the dialog; the wizard showed the per-heir option and the testnet bridge note.

### Edit notice and guardian recovery (D28, D29)

`e2e-recovery`, 2026-11-12, after upgrading `behest-ekkr6.testnet` in place (wasm `9c77731b…`, demo timers). A fresh owner paid Standard and saved a plan with G1–G3 (quorum 2), Tobi as standby, a 1-minute availability window and swap notice, and a 1-minute edit notice. Changing Amara's destination was queued, not applied. Applying it early failed (`E_CHANGE_NOT_DUE`), and the owner cancelled it. Queued again together with turning the notice off, both waited out the notice and a guardian applied them. G3 went past the window; Amara called the standby; finishing early failed; G3 confirmed and the swap was called off. G3 went quiet again, and Tobi took the seat after the delay, with the quorum still 2. With G1 and G2 also quiet, the status reported 1 of 2 available until they confirmed. G1 moved its seat to a new account: the owner cancelled the first request, and the second landed after the delay; the old account was then refused (`E_NOT_GUARDIAN`). G2 resigned with no standby left: the seat stayed, marked resigned (`E_GUARDIAN_RESIGNED`), with the quorum unchanged. In the app (headless Chrome, personas) the owner set a 2-minute notice and saved standby settings, which showed as waiting with a countdown. Guardian G1 saw the warning banner and confirmed from "Your guardian seat", standby Tobi confirmed from the standby card, and the owner cancelled the queued change from the banner.

### Destination proofs and requests (D30, D31)

`e2e-destinations`, 2026-11-12, after upgrading `behest-ekkr6.testnet` in place (wasm `892bd62b…`, demo timers). A fresh owner paid Standard and gave Amara a NEAR wallet account, a fresh Ethereum key and a fresh `tb1q` address. Amara's own account couldn't prove the wallet (`E_DESTINATION_PROOF`); the wallet proved itself. A guardian submitted Amara's EIP-191 and BIP-137 signatures, which were accepted; a signature from another key and an unregistered address were refused. A guardian couldn't ask for a change (`E_NOT_RECIPIENT`). Amara asked for a new, proven Ethereum address, and the owner rejected it: nothing changed. With a 1-minute edit notice on, Amara asked for a second NEAR wallet, which proved itself; the owner approved; the change was queued, applying it early failed (`E_CHANGE_NOT_DUE`), and a guardian applied it after the notice, with the proof carried over. In the app (headless Chrome, personas), Amara saw three proven addresses and asked for a new one; the owner saw "3 of 3 proven", the request marked as not proven, and the recovery guidance, and rejected it.

### Private heirs (D33)

`e2e-private`, 2026-11-12, after upgrading `behest-ekkr6.testnet` in place (wasm `204ac2cd…`, demo timers). A fresh owner paid Standard and saved a private plan: Amara 60% (paid to a fresh wallet account) and Tobi 40%, sealed as two fingerprints computed off-chain, which matched `get_heir_commitment`. `get_plan` listed no heirs and nothing about Amara or her wallet. A reveal while the owner was active failed (`E_REVEAL_NOT_OPEN`). Once overdue, a guardian revealed Amara's record. A record with another salt or another share was refused (`E_UNKNOWN_COMMITMENT`), as were a second reveal (`E_ALREADY_REVEALED`) and a release before Tobi was revealed (`E_REVEALS_PENDING`). The owner checked in, which cleared the reveals. Overdue again, Amara revealed herself and Tobi didn't. After the 2-minute reveal window, a guardian proposed the release with Amara at 100%. Once approved and the waiting period was over, Amara claimed, and her wallet received exactly the 0.2 NEAR escrow. In the app (headless Chrome, personas), the owner chose Private with a 2-minute reveal window in the wizard, saved, and downloaded the records. Owner, guardian and public views showed "2 private heirs". A browser without the records was offered restore and couldn't print packets. Once overdue, Amara pasted her record and saw "1 of 2 revealed".

### Clean reproduction (Stage 1 exit gate)

On 2026-11-08 a second deployment was built from scratch with no faucet: `bootstrap r1`, a source rebuild (same wasm sha256 `0e2c65ea…` as the main deployment), then `deploy-contract r1 --parent` (`deployments/r1.json`). Every NEAR scenario passed on it. So did `e2e-eth`: [Tobi, nonce 0](https://sepolia.etherscan.io/tx/0x5f1abb07f7b96c33cbc22676dc0b0cf959fba10519beff9d1875def09035de21) and [Amara, nonce 1](https://sepolia.etherscan.io/tx/0x020eccf530488d8991f0e8db5d91d23ba7176c1ae9230497fca055d46f743e85), each with its exact share. The run surfaced two tooling issues, both fixed: scenario owners were never reclaimed, and an error check crashed on BigInt fields.

### Found by the live runs: Sepolia gas rules changed

Since Glamsterdam, the first value transfer to an address that has never been used costs about 207k gas instead of 21k. Our first two-heir run used fresh wallets, so both transfers reverted with a fixed 21k limit, and the vault still paid the fees. The gas limit is now admin config (testnet: 250k), snapshotted per proposal. The executor refuses to broadcast when the signed limit is below the estimate, and `reissue_reverted_transfer` recovers mined reverts. The deployed contract was upgraded in place with `deploy-contract ekkr6 --migrate`; old plans convert lazily, and the reverted plan was recovered live (docs/spec/03-signing-boundary.md).

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
- [x] Heir recovery packet: a printable page per heir (`/plan/<owner>/packet?heir=…`) and a JSON download with where the plan lives (contract, vaults, explorer links), each heir's share, fixed amounts, alternate/fallback, destinations and release mode, the timeline in words, and claim steps in the app, with `near` CLI commands, or by Ethereum wallet; public data only, linked from the owner and heir screens and the "ready to receive" notice
- [x] Plan tiers and service-fee accounting: Free / Standard / Complete paid once in USDC by anyone, credit toward upgrades, saves gated and releases never; fee revenue in a treasury separate from escrow, network-fee reserves and the sponsor pool, shown apart on the owner screen and on Inspect; NEAR Intents for any asset on mainnet, test USDC on testnet (D25, threats 44–46; live `e2e-tiers`)
- [x] DAOs and multisigs in any role: "Act as a DAO" sessions turn every call into a SputnikDAO proposal with a plain-words description and vote buttons; check-in delegates (≤ 10, check in only, Standard tier); DAO plans pay their own storage; wizard warnings for voting windows and DAO heirs; council-wide notifications (D26, threats 47–49; live `e2e-dao`)
- [x] Heirs receive through NEAR Intents: per-recipient opt-in (Standard), NEAR wrapped and sent atomically, tokens from escrow, any refund a failure retried for the rest; Intents balance, withdraw and (mainnet) 1Click swaps on the heir screen; bridge addresses for ETH/BTC on mainnet (D27, threats 50–51; live `e2e-intents` against a mock verifier)
- [x] Testnet cost cut: fee cap 3 gwei, dust-sized test amounts, `recover-vaults` (recovered ≈0.021 ETH stranded by earlier runs)

## Stage 3 progress (public testnet beta)

- [x] Claim modes per heir and asset group (D19, shipped in Stage 2)
- [x] Edit notice (cooling-off) for high-impact edits: validated and queued, re-validated and applied by anyone after the notice, cancellable by the owner, never during an open release; lowering it also waits; notices to guardians and heirs that can't be switched off (D28, threats 1, 54; live `e2e-recovery`)
- [x] Guardian recovery without lowering the quorum: standby guardians, availability confirmations (votes count), standby swaps after a notice that the guardian cancels by confirming, key rotation, resignation, "quorum unreachable" status and alerts (D29, threats 3, 52–53, 55; live `e2e-recovery`)
- [x] Heir proof-of-control for registered destinations: NEAR by calling, EIP-191, BIP-137 for `tb1q`; bound to the exact address; evidence only (D30, threats 17, 56; live `e2e-destinations`)
- [x] Destination updates while the owner is active: recipient requests, owner approval under the edit notice; owner account-recovery guidance in the app (D31, threats 57–59; live `e2e-destinations`)
- [x] Guided presets (Careful, Balanced, Quick, or from scratch) that fill in timers, guardians, the edit notice and availability checks, all editable; a plain-language summary with consequences and warnings, before saving, on every plan view and during a release (D32)
- [x] Commitment-based private heir details: sealed fingerprints, reveal once overdue, resealed on check-in, unrevealed shares redistributed or to the fallback; records in each heir's packet, optional encrypted Behest backup; public mode stays (D33, threats 60–65; live `e2e-private`)
- [x] Heirs and guardians named by email: wallets created for the address before they ever sign in, emails to them from the owner's plan only, email sign-in, claim, and send-out of NEAR, ETH and BTC from the same screen (D34, threats 66–70; live run in the browser with real inboxes: named → told → guardian releases → heir receives → sends NEAR, Sepolia ETH and testnet Bitcoin on; an owner signed in by email creating a plan; the heir's Bitcoin address offered in the plan's Bitcoin destinations and proven on-chain in one click)
- [ ] Property/state-machine tests and fuzzing; upgrade and long-timer tests
- [ ] A second independent executor
- [ ] RPC failover, durable job queues, alerts, runbooks, status page
- [ ] Signed, reproducible builds; secret rotation; dependency scanning
- [ ] Treasury and fee-reserve dashboards
- [ ] Recovery drills, testnet bug bounty, independent review
