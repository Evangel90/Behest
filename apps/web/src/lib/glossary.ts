// Plain-language explanations for the words the app can't avoid. Shown in
// tooltips wherever the term appears.
export const GLOSSARY = {
  checkIn: "A one-tap signal that you're here. Each check-in restarts the clock; Behest pays the gas.",
  grace: "Extra time after a missed check-in before guardians can do anything. A buffer for holidays and lost phones.",
  waiting: "After guardians approve a release, nothing moves until this period passes. The owner can cancel at any point during it.",
  quorum: "How many guardians must approve before a release goes ahead. No guardian can act alone.",
  guardian: "Someone you trust to notice you're unreachable. Guardians can only release the plan exactly as written; they can never change where funds go.",
  heir: "Someone who receives a share. Their destination addresses are fixed in the plan.",
  delaySigner: "Someone who can lengthen an approved release's waiting period, within limits you set. They can't approve, cancel or move anything.",
  vault: "An address on another chain that only this plan can sign for, through NEAR Chain Signatures. Nobody holds its key.",
  escrow: "NEAR held by the Behest contract for this plan. Only the plan's rules can move it.",
  feeReserve: "Network fees set aside from the plan before anything is split, so heirs never pay them. What isn't used stays in the vault.",
  claimWindow: "How long each person has to claim before their share can be passed to an alternate or the fallback.",
  releaseMode: "Claim: heirs start their own transfers. Automatic: transfers start by themselves. Hybrid: heirs can claim first, then it's automatic.",
  followUp: "After a release completes, anything left (later deposits, or an amount the last proposal missed) can go out in another round, split by the same rules.",
  snapshot: "The balances a proposal was built from. Guardians compare them with the live vaults before voting.",
  unreachable: "The owner missed a check-in and the grace period ran out. Behest never assumes anything more than that.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
