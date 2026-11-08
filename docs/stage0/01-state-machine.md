# 01 · State machine (MVP)

Two levels of state: one **plan state** per owner, and one **transfer state** per (heir, asset) once a release is eligible.

All times are NEAR block timestamps in milliseconds (`env::block_timestamp_ms()`). "Now" below means the block timestamp of the transaction being processed.

## Plan states

| State | Stored or derived | Meaning |
|---|---|---|
| `Active` | derived | No proposal; `now < last_check_in + check_in_interval + grace` |
| `Overdue` | derived | No proposal; `now >= last_check_in + check_in_interval + grace`. UI copy: **"Owner unreachable"** |
| `Proposed` | stored | A guardian opened a release proposal; approvals below quorum |
| `Waiting` | stored | Quorum reached; `now < waiting_ends_at`. Owner can still cancel |
| `Eligible` | derived | Stored `Waiting` and `now >= waiting_ends_at`. Heirs may claim |
| `Executing` | derived | At least one transfer has left `Pending` and not all are `Confirmed` |
| `Settled` | derived | Every transfer is `Confirmed` |
| `Cancelled` | event, not a resting state | The owner cancelled or checked in during `Proposed`/`Waiting`; the plan returns to `Active` and the proposal is archived as `Cancelled` |

`Approved` from the roadmap is the instant quorum is reached. It is recorded as `approved_at` and immediately starts `Waiting`, so it is not a separate resting state in the MVP.

Derived states are computed in a single view function (`get_plan_status`) so the contract, executor and UI never disagree.

### Plan transitions

| # | Transition | Caller | Preconditions | Effects | Idempotency / repeat |
|---|---|---|---|---|---|
| P1 | create plan | owner | owner has no plan; schema valid (04); attached deposit ≥ storage cost | plan stored at `version = 1`; `last_check_in = now` | second call fails `PlanExists` |
| P2 | replace plan | owner | plan exists; **no open proposal** | plan replaced, `version += 1`, also counts as a check-in | each call is a new version |
| P3 | check in | owner | plan exists; `now < waiting_ends_at` if a proposal is in `Waiting` | `last_check_in = now`; if a proposal is open it is cancelled (P7) | repeating just moves `last_check_in` |
| P4 | propose release | guardian; or a heir for a follow-up round (D21: a release settled and the owner hasn't checked in since) | state `Overdue`, or `Settled` (archived first); no open proposal; fee reserve check passes (03) | proposal stored with snapshot of plan version, balances (reported ones recorded for `get_release_snapshot`), per-heir amounts; a guardian proposer's approval recorded | fails `ProposalExists` if one is open |
| P5 | approve | guardian | proposal `Proposed`; caller has not approved this proposal id | approval recorded; if approvals ≥ quorum: `approved_at = now`, `waiting_ends_at = now + waiting_period`, state `Waiting` | second approval by same guardian fails `AlreadyVoted` |
| P6 | reject | guardian | proposal `Proposed`; caller has not voted | rejection recorded; if `guardians − rejections < quorum` the proposal is dropped like a cancel (NEAR, NEP-141 shares and the token-registration reserve return to escrow) and the plan returns to `Overdue` | second vote fails `AlreadyVoted` |
| P7 | cancel | owner | proposal `Proposed`, or `Waiting` with `now < waiting_ends_at` | proposal archived as `Cancelled`; `last_check_in = now`; plan `Active` | cancelling with no open proposal fails `NoProposal` |
| P8 | claim | heir | state `Eligible` or `Executing`; heir has `Pending` or retryable transfers | starts each of the heir's transfers (T1) | already-started transfers are skipped, not duplicated |
| P9 | withdraw NEAR | owner | state `Active`/`Overdue`; no open proposal | sends NEAR from the plan's escrow to the owner | amount ≤ escrow balance |
| P10 | deposit NEAR | anyone | plan exists; no open proposal | escrow balance increases | additive |

**After `Settled` (D21):** the next check-in, deposit, plan edit or proposal first moves the settled release to the plan's history (`get_release_history`, last 5) and records its fixed amounts as paid. The plan is then `Active` (after a check-in) or `Overdue`, so a follow-up round can distribute anything left; fixed amounts are paid once across rounds.

**Last cancellation point:** `waiting_ends_at`. P3 and P7 are rejected at or after it; P8 is rejected before it. The two windows never overlap.

## Transfer states (per heir, per asset)

Created from the proposal snapshot when quorum is reached. Amount and destination are copied from the snapshot and never change afterwards.

| State | Meaning |
|---|---|
| `Pending` | Eligible, not yet claimed |
| `Sending` | NEAR: transfer promise in flight |
| `Signing` | ETH: MPC `sign` call in flight |
| `Signed` | ETH: signature stored; signed transaction ready to broadcast |
| `Broadcast` | ETH: executor reported a transaction hash |
| `Confirmed` | NEAR: promise succeeded. ETH: executor reported inclusion with ≥ N confirmations |
| `Failed` | Retryable failure (reason code stored) |

### Transfer transitions

| # | Transition | Caller | Preconditions | Effects | Idempotency |
|---|---|---|---|---|---|
| T1a | start NEAR transfer | heir (via claim) | `Pending` or `Failed` | state `Sending`; `Transfer` promise to the heir's NEAR destination; callback sets `Confirmed` or `Failed(PromiseFailed)` | transfer marked in-flight before the promise; a second claim skips it |
| T1b | start ETH transfer | heir (via claim) | `Pending` | assign the next nonce of the plan's ETH vault; build the exact payload (03); call MPC `sign`; state `Signing` | nonce assigned once, never reused for another transfer |
| T2 | signature callback | contract (self) | `Signing` | success → `Signed` with `(big_r, s, recovery_id)` stored; failure → `Failed(SignFailed)` | callback is private to the contract |
| T3 | report broadcast | registered executor | `Signed` or `Broadcast` | store tx hash; state `Broadcast` | reporting the same hash again is a no-op |
| T4 | report confirmed | registered executor | `Broadcast` | state `Confirmed` | repeat is a no-op |
| T5 | report failed | registered executor | `Signed` or `Broadcast` | state `Failed(reason)` | repeat updates the reason |
| T6 | retry (`retry_transfer`) | heir or registered executor | `Failed` (NEAR failures can also be retried by the heir via `claim`) | re-sign **the same nonce, recipient and value** with a fee bump bounded by the fee cap; state `Signing` | the nonce never changes, so at most one transfer can ever land |

The executor's reports cannot change recipient, amount, chain or nonce. A false report can only mislabel status; the heir verifies receipt through the explorer link (see 05).
