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
} as const;
export type SponsoredMethod = keyof typeof SPONSORED_METHODS;
export type Role = (typeof SPONSORED_METHODS)[SponsoredMethod];
