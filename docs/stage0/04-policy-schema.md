# 04 · MVP policy schema

```jsonc
// set_plan(plan: PlanInput)
{
  "check_in_interval_ms": 7776000000,   // 90 days
  "grace_ms": 604800000,                // 7 days
  "waiting_period_ms": 2592000000,      // 30 days
  "guardians": ["dayo.testnet", "funmi.testnet", "chidi.testnet"],
  "quorum": 2,
  "heirs": [
    {
      "account_id": "amara.testnet",            // authorizes claim
      "share_bps": 5000,                        // basis points, sum = 10000
      "near_destination": "amara.testnet",      // optional
      "eth_destination": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" // optional
    }
  ]
}
```

## Validation rules (contract-enforced)

| Rule | Error |
|---|---|
| 1 ≤ heirs ≤ 10 | `InvalidHeirs` |
| heir `account_id`s unique | `DuplicateHeir` |
| each `share_bps` > 0 and the sum = 10000 | `InvalidShares` |
| every heir has at least one destination | `NoDestination` |
| `eth_destination` is `0x` + 40 hex characters | `InvalidEthAddress` |
| 1 ≤ guardians ≤ 10, unique | `InvalidGuardians` |
| 1 ≤ quorum ≤ guardians | `InvalidQuorum` |
| guardians are not the owner and not heirs | `ConflictingRole` |
| each duration within `[min, max]` of the network timer profile | `DurationOutOfBounds` |

## Timer profiles

Bounds are compiled in, not passed at runtime, so a production build cannot accept demo timers.

| Profile | Build | check-in interval | grace | waiting period |
|---|---|---|---|---|
| `demo` | `cargo near build --features demo-timers` (testnet only) | 1 min – 365 days | 0 – 30 days | 1 min – 180 days |
| `production` | default | 30 – 365 days | 1 – 30 days | 7 – 180 days |

## Allocation arithmetic

- Distributable amount per asset = snapshot balance − fee reserve (ETH) or snapshot balance (NEAR).
- Heir amount = `floor(distributable × share_bps / 10000)`.
- **Remainder rule:** the rounding remainder (< 1 unit per heir, in yocto or wei) stays in the vault/escrow. It is shown in the proposal preview. Nothing is implicitly redirected.
- An heir with no destination on a chain receives nothing on that chain. Their share of that asset is **not** redistributed in the MVP. The plan review screen must say so, and `set_plan` returns a warning list for it.

## Balance snapshot (decision D5)

- **NEAR:** the plan escrow balance held by the contract at proposal time (exact).
- **ETH:** reported by the proposing guardian, displayed with the explorer link, and implicitly confirmed by every approving guardian. Withdrawals are frozen once a proposal exists, so the balance can only grow. Post-snapshot deposits are not distributed in the MVP.
