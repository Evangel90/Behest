/** Non-payable Behest methods the relayer sponsors, and the role the sender must hold. */
export const SPONSORED_METHODS = {
  claim: "heir",
  retry_transfer: "heir",
  propose_release: "guardian",
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
