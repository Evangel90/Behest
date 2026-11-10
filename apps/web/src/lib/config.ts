export const CONTRACT_ID = process.env.NEXT_PUBLIC_BEHEST_CONTRACT_ID ?? "behest-ekkr6.testnet";
export const NEAR_RPC = process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8787";
export const SEPOLIA_RPC = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const MPC_CONTRACT = "v1.signer-prod.testnet";
export const NEAR_EXPLORER = "https://testnet.nearblocks.io";
export const ETH_EXPLORER = "https://sepolia.etherscan.io";
export const BTC_ESPLORA = process.env.NEXT_PUBLIC_BTC_ESPLORA_URL ?? "https://blockstream.info/testnet4/api";
export const BTC_EXPLORER = "https://mempool.space/testnet4";
export const NOTIFIER_URL = process.env.NEXT_PUBLIC_NOTIFIER_URL ?? "http://localhost:8790";
/** NEP-413 recipient the notifier expects (its NOTIFY_SIGN_RECIPIENT). */
export const NOTIFY_RECIPIENT = process.env.NEXT_PUBLIC_NOTIFY_RECIPIENT ?? "behest-notifier";
