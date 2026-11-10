/** Non-payable Behest methods the relayer sponsors, and the role the sender must hold. */
export const SPONSORED_METHODS = {
  claim: "heir",
  retry_transfer: "heir",
  // guardians; heirs too for a follow-up round (D21, the contract decides when)
  propose_release: "guardian_or_heir",
  approve_release: "guardian",
  reject_release: "guardian",
  check_in: "owner",
  cancel_release: "owner",
  reassign_unclaimed: "participant",
  request_extension: "delay_signer",
  approve_extension: "delay_signer",
  release: "participant",
  register_btc_vault: "participant",
  rebase_btc: "guardian",
  // D24: owner configuration with no deposit; the contract pays its storage
  // from the sponsor pool (per-owner allowance, daily cap on new plans).
  // set_plan always acts on the sender's own plan, which may not exist yet.
  set_plan: "self",
  set_release_rules: "owner",
  set_release_options: "owner",
  set_btc_destinations: "owner",
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
