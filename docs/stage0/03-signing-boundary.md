# 03 · Signing boundary (Sepolia ETH via Chain Signatures)

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
| `to` | heir's ETH destination from the proposal snapshot | no |
| `value` | heir's ETH amount from the proposal snapshot | no |
| `data` | empty | no |
| `gas_limit` | `21000` | no |
| `max_priority_fee_per_gas`, `max_fee_per_gas` | first attempt: admin-set `eth_priority_fee` and `eth_initial_max_fee` (clamped to the cap); each retry bumps both by ≥ 12.5% (replacement rule), never above the global `eth_max_fee_cap` | yes, bounded |
| `access_list` | empty | no |

The contract computes `keccak256(0x02 || rlp(fields))` and sends it as `payload_v2: { "Ecdsa": "<hex>" }`, with 1 yoctoNEAR deposit and 50 Tgas for the MPC call (the testnet MPC contract v3.18 requires 15 Tgas attached). The returned `(big_r, s, recovery_id)` is stored with the transaction fields so anyone (normally the executor) can assemble the raw signed transaction and broadcast it.

Every signed version of a transfer is kept in contract state (`get_signed_tx_versions`, at most 32). Any executor, including a freshly started one with no local state, can therefore find which version was mined.

Because the nonce is fixed per transfer, a retry can only replace the same transfer. Two different transfers can never both land with the same nonce, and a stale signed copy of the same transfer is harmless.

Callbacks carry an attempt number, so a late MPC response for a superseded attempt can't attach a signature to the current one. The contract doesn't verify the signature itself (it would need the derived public key on-chain). The executor must `ecrecover` every signed transaction and check the sender is the plan's vault address before broadcasting. An invalid signature can't move funds anyway, because the recovered sender would not be the vault.

## Fee sponsorship (MVP)

- Destination-chain fees come from the ETH vault itself. At proposal time the contract reserves `eth_heir_count × 21000 × max_fee_cap` from the reported ETH balance before computing shares, so heirs never need ETH for gas.
- If the reported balance is below that reserve, `propose_release` fails with `InsufficientFeeReserve` (one of the required failure demos).
- If network fees exceed `max_fee_cap`, the executor reports `Failed(FeeAboveCap)` and retries later; funds stay in the vault.
- NEAR gas for `claim` is paid by the heir's NEAR account in the MVP. NEP-366 meta-transactions through a relayer are a Stage 2 item.

## Nonce gaps

Only the contract signs for the vault, so it knows the next nonce. A gap appears only if a signed transaction is never mined. The executor rebroadcasts or the transfer is retried with the same nonce. Transfers are signed in nonce order, and a later transfer whose predecessor nonce is still unconfirmed is reported as `Failed(NonceGap)` and retried after it.
