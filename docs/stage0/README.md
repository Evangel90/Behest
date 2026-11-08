# Stage 0: decisions, architecture and threat model

This folder is the source of truth that the contract, executor and web app must all encode identically. If code and these documents disagree, fix one of them in the same change.

| Doc | What it fixes |
|---|---|
| [01-state-machine.md](01-state-machine.md) | Plan and transfer states, every transition, caller, preconditions, idempotency |
| [02-permissions.md](02-permissions.md) | What each role can and cannot do |
| [03-signing-boundary.md](03-signing-boundary.md) | Exactly when and what the contract asks the MPC network to sign |
| [04-policy-schema.md](04-policy-schema.md) | MVP plan schema and validation rules |
| [05-threat-model.md](05-threat-model.md) | Threats, mitigations and accepted MVP risks |
| [06-decisions.md](06-decisions.md) | Architecture and MVP product decisions (ADR log) |

## Exit-gate checklist (from the roadmap)

- [x] Every state transition has an authorized caller, preconditions, outputs, cancellation behaviour and an idempotency rule (01).
- [x] No role other than the owner can change heirs, destinations or allocations (02, enforced by `set_plan` being owner-only and frozen while a proposal exists).
- [x] The last owner-cancellation point is defined (`waiting_ends_at`) and no destination-chain signature can be requested before it (03).
- [x] Decisions affecting stored data or authorization are resolved or explicitly deferred (06).
