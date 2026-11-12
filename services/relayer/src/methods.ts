/** Non-payable Behest methods the relayer sponsors, and the role the sender must hold. */
export const SPONSORED_METHODS = {
  claim: "heir",
  retry_transfer: "heir",
  // guardians; heirs too for a follow-up round (D21, the contract decides when)
  propose_release: "guardian_or_heir",
  approve_release: "guardian",
  reject_release: "guardian",
  // The owner, or (D26) one of its check-in delegates naming it in args.owner.
  check_in: "owner_or_delegate",
  cancel_release: "owner",
  reassign_unclaimed: "participant",
  request_extension: "delay_signer",
  approve_extension: "delay_signer",
  release: "participant",
  register_btc_vault: "participant",
  register_near_vault: "participant",
  rebase_btc: "guardian",
  // D24: owner configuration with no deposit; the contract pays its storage
  // from the sponsor pool (per-owner allowance, daily cap on new plans).
  // set_plan always acts on the sender's own plan, which may not exist yet.
  set_plan: "self",
  set_release_rules: "owner",
  set_release_options: "owner",
  set_btc_destinations: "owner",
  set_checkin_delegates: "owner",
  // D27
  set_intents_delivery: "owner",
  // D28: edit notice. Applying a due change is open to anyone on-chain; the
  // relayer sponsors it for the plan's participants and standbys.
  set_edit_notice: "owner",
  cancel_change: "owner",
  apply_changes: "participant_or_standby",
  // D29: guardian recovery
  set_guardian_settings: "owner",
  confirm_guardian: "guardian_or_standby",
  request_standby: "participant_or_standby",
  rotate_guardian: "guardian",
  resign_guardian: "guardian",
  finalize_guardian_change: "participant_or_standby",
  cancel_guardian_change: "owner_or_guardian",
  // D30: a plan member submits a signed proof, or a NEAR destination proves itself
  prove_destination: "participant_or_destination",
  // D31: heirs, named alternates and the fallback ask; the owner answers
  request_destination_change: "recipient",
  cancel_destination_change: "recipient",
  respond_destination_change: "owner",
  // D33: a sealed plan is saved like set_plan; a heir reveals its own record
  // (checked against the plan's commitments first), or a participant does.
  set_private_plan: "self",
  reveal_heir: "sealed_heir",
} as const;
export type SponsoredMethod = keyof typeof SPONSORED_METHODS;

/**
 * D23: what an EVM wallet may do through `evm_call` (the contract's
 * EVM_METHODS). Adds the owner's withdrawals, which NEAR wallets sign and pay
 * for themselves; an EVM owner has no other way to reach them.
 */
export const EVM_METHODS = {
  ...SPONSORED_METHODS,
  withdraw: "owner",
  withdraw_ft: "owner",
  withdraw_vault: "owner",
  withdraw_btc: "owner",
  cancel_vault_withdrawal: "owner",
} as const;
export type EvmMethod = keyof typeof EVM_METHODS;
export type Role = (typeof EVM_METHODS)[EvmMethod];
