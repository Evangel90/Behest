# 02 · Permissions matrix (MVP)

✓ = allowed (subject to the state preconditions in 01). ✗ = rejected by the contract.

| Action | Owner | Guardian | Heir | Executor | Admin | Anyone |
|---|---|---|---|---|---|---|
| Create / replace plan | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Change heirs, destinations, allocations, quorum | ✓ (only with no open proposal; queued for the edit notice if one is set, D28) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Set the edit notice; cancel a queued edit (D28) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Apply a queued edit once its notice has passed (D28) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Set standby guardians and availability (D29) | ✓ (an edit under D28) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Confirm availability (D29) | ✗ | ✓ (and standbys) | ✗ | ✗ | ✗ | ✗ |
| Rotate own seat to a new account; resign (D29) | ✗ | ✓ (own seat) | ✗ | ✗ | ✗ | ✗ |
| Ask a standby to fill a resigned or unresponsive seat; finalize a due seat change (D29) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cancel a pending seat change (D29) | ✓ (any) | ✓ (own) | ✗ | ✗ | ✗ | ✗ |
| Prove control of a destination (D30) | ✗ | ✗ | ✓ (from the NEAR destination, or anyone submitting a valid signature) | ✓ | ✓ | ✓ |
| Request a destination change (D31) | ✗ | ✗ | ✓ (own; alternates and the fallback too; only while the owner is active) | ✗ | ✗ | ✗ |
| Approve or reject a destination request (D31) | ✓ (an edit under D28) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Check in | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Cancel proposal (before `waiting_ends_at`) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Deposit NEAR to plan escrow | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Withdraw NEAR from escrow | ✓ (no open proposal) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Propose release | ✗ | ✓ (when `Overdue`, or after a settled release) | ✓ (follow-up round only: a release settled and the owner hasn't checked in since; D21) | ✗ | ✗ | ✗ |
| Approve / reject proposal | ✗ | ✓ (once per proposal) | ✗ | ✗ | ✗ | ✗ |
| Claim own share | ✗ | ✗ | ✓ (own only, after `waiting_ends_at`) | ✗ | ✗ | ✗ |
| Retry a failed ETH transfer | ✗ | ✗ | ✓ (own) | ✓ | ✗ | ✗ |
| Report broadcast / confirmed / failed | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Prove a Sepolia outcome (`prove_eth_outcome`); re-issue a **proven** revert (D22) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (the proof is checked against the Ethereum light client, so the caller isn't trusted) |
| Set the Ethereum light client | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Add / remove executors, set global fee cap, pause new plans and new signing | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Read any plan, proposal or transfer | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## What nobody can do

These are invariants that the contract tests must exercise as negative cases:

1. **Nobody** can change a transfer's recipient, amount, chain or nonce once the proposal snapshot exists, including the owner (the owner can only cancel and start over).
2. **No guardian** can approve a transfer to anywhere except the snapshot destinations, and approvals are bound to a proposal id, not to the plan.
3. **No executor** can request a signature for a payload the contract did not build, and its status reports do not move funds.
4. **The admin** can pause new plans and new signing requests but has no method that moves plan funds or edits plans. (Contract-upgrade authority is the exception; see 05 and 06.)
5. **Nobody** can trigger a destination-chain signature before `waiting_ends_at`.

## Identities

- Owner, guardians, heirs and executors are NEAR account IDs.
- An heir's destinations are per chain: a NEAR account for NEAR and a `0x…` address for Sepolia ETH. The heir's NEAR account (used to authorize `claim`) is separate from their destinations.
- A guardian may not also be an heir or the owner in the same plan (validation rule; avoids self-dealing).
