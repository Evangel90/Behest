# 03 · Signing boundary (Sepolia ETH and ERC-20 via Chain Signatures)

## Who controls the ETH vault

Each plan's ETH vault address is derived by the MPC network from:

- **predecessor** = the Behest contract account (e.g. `behest.testnet`), because the contract itself calls `sign`;
- **path** = `behest/v1/{owner_account_id}/eth`;
- **domain_id** = `0` (secp256k1 / ECDSA).

Only the Behest contract can obtain signatures for this address, and it does so only inside the code paths below. No person, guardian or executor holds the key. The web app shows this derived address for funding, and the executor verifies it with `derived_public_key(path, predecessor, 0)` on the MPC contract.

MPC contract: `v1.signer-prod.testnet` (testnet), `v1.signer` (mainnet). Configured at contract init, not hard-coded.

## When a signature may be requested

The contract calls the MPC `sign` method only when **all** of these hold:

1. `now >= waiting_ends_at` of a proposal that reached quorum (the last owner-cancellation point has passed);
2. the plan is not paused by the admin;
3. the caller is the heir of that transfer (first attempt) or the heir or a registered executor (retry of a `Failed` transfer);
4. the transfer is `Pending` (first attempt) or `Failed` (retry).

## Exactly what is signed

An EIP-1559 (type 2) transaction, built inside the contract by `contracts/behest/src/eth.rs` (a dependency-free RLP encoder, checked against viem in the unit tests), with every field fixed by contract state:

| Field | Source | Can change on retry? |
|---|---|---|
| `chain_id` | global config: `11155111` (Sepolia) | no |
| `nonce` | assigned once from the plan's `eth_next_nonce` when the transfer first starts | no |
| `to` | ETH: heir's ETH destination from the proposal snapshot. ERC-20: the token contract from the snapshot | no |
| `value` | ETH: heir's amount from the snapshot. ERC-20: `0` | no |
| `data` | ETH: empty. ERC-20: `transfer(heir destination, heir amount)` (`0xa9059cbb` + two 32-byte words) | no |
| `gas_limit` | the proposal's `eth_gas_limit`, snapshotted from admin config `eth_gas_limit` (testnet: 250 000) when the proposal opens | only upward, on a same-nonce re-sign |
| `max_priority_fee_per_gas`, `max_fee_per_gas` | first attempt: admin-set `eth_priority_fee` and `eth_initial_max_fee` (clamped to the cap); each retry bumps both by ≥ 12.5% (replacement rule), never above the global `eth_max_fee_cap` | yes, bounded |
| `access_list` | empty | no |

The contract computes `keccak256(0x02 || rlp(fields))` and sends it as `payload_v2: { "Ecdsa": "<hex>" }`, with 1 yoctoNEAR deposit and 50 Tgas for the MPC call (the testnet MPC contract v3.18 requires 15 Tgas attached). The returned `(big_r, s, recovery_id)` is stored with the transaction fields so anyone (normally the executor) can assemble the raw signed transaction and broadcast it.

Every signed version of a transfer is kept in contract state (`get_signed_tx_versions`, at most 32). Any executor, including a freshly started one with no local state, can therefore find which version was mined.

Because the nonce is fixed per transfer, a retry can only replace the same transfer.

### ERC-20 tokens (Stage 2)

Tokens move from the same vault address, so they share its nonce sequence with ETH transfers; claim order fixes the nonces.
- **Allowlist only.** The admin sets the allowed tokens (`set_erc20_tokens`, at most 4; testnet: WETH `0xfff99767…6b14`). The proposer reports each token's vault balance with `erc20_balances`, just as it reports `eth_balance` (D5). An unlisted or repeated token fails with `E_UNKNOWN_TOKEN`. A proposal snapshots the token address in each transfer (`Asset::Erc20`), so changing the allowlist later doesn't alter an open proposal.
- **Reverting tokens only.** The executor treats a successful receipt as a delivered transfer. Tokens that return `false` instead of reverting must not be allowlisted.
- **Executor check.** Before broadcasting, the executor recomputes the expected call (`to`, `value`, `data`) from the snapshot and refuses any signed transaction that differs. That includes a different recipient or amount inside the calldata, or ETH attached to a token call.
- **Over-reported balance.** If a guardian over-reports a token balance, the token's `transfer` reverts and the vault pays that transaction's fee from the reserve. The admin can re-issue once the real balance is there (same as ETH, threat 20). Under-reported tokens stay in the vault (D12/D5 residual).

### Gas limit

A fixed 21 000 was the original design. Since Sepolia's Glamsterdam upgrade (observed November 2026), a value transfer to an address that has never been used costs about 207 000 gas. The first live two-heir run, with freshly generated heir wallets, reverted both transfers with 21 000 used, and the vault still paid the fees. The limit is therefore admin config (bounded to 15 000–2 000 000), snapshotted into each proposal so the fee reserve and the signed transactions agree. Unused gas isn't charged.

- Before its first broadcast of a transfer, the executor estimates the gas the transfer needs. If the signed limit is lower, it reports `Failed(GasLimitTooLow)` instead of sending. The admin raises `eth_gas_limit`, and a retry re-signs at the **same nonce** with the higher limit. Only one version can ever be mined, so this needs no trust.
- A transfer that was mined but reverted has used up its nonce, so it can't be retried. `reissue_reverted_transfer` (admin only) re-signs it on a fresh nonce with the current gas limit and initial fees. The contract can't see Ethereum, so this relies on the admin having confirmed the revert on-chain (`pnpm --filter @behest/testnet reissue <owner>` checks the receipt before calling). See threat 20 in 05-threat-model. Two different transfers can never both land with the same nonce, and a stale signed copy of the same transfer is harmless.

Callbacks carry an attempt number, so a late MPC response for a superseded attempt can't attach a signature to the current one. The contract doesn't verify the signature itself (it would need the derived public key on-chain). The executor must `ecrecover` every signed transaction and check the sender is the plan's vault address before broadcasting. An invalid signature can't move funds anyway, because the recovered sender would not be the vault.

## Fee sponsorship (MVP)

- Destination-chain fees come from the ETH vault itself, for token transfers too. At proposal time the contract reserves `eth_gas_limit × max_fee_cap` for every vault transaction before computing shares, so heirs never need ETH for gas.
  - Token transfers come first: `eth_heir_count × tokens_held` transactions.
  - ETH is split only if what's left also covers the `eth_heir_count` ETH transfers; otherwise the remaining ETH stays in the vault.
- If the reported ETH can't cover the token transfers, or there are no tokens and it doesn't exceed the ETH reserve, `propose_release` fails with `InsufficientFeeReserve` (one of the required failure demos).
- If network fees exceed `max_fee_cap`, the executor reports `Failed(FeeAboveCap)` and retries later; funds stay in the vault.
- NEAR gas for heirs and guardians is sponsored by the NEP-366 relayer (`services/relayer`, D14). Calling directly still works if the relayer is down.

## Nonce gaps

Only the contract signs for the vault, so it knows the next nonce. A gap appears only if a signed transaction is never mined. The executor rebroadcasts or the transfer is retried with the same nonce. Transfers are signed in nonce order, and a later transfer whose predecessor nonce is still unconfirmed is reported as `Failed(NonceGap)` and retried after it.
