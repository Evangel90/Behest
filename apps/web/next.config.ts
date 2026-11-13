import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// One .env at the repo root serves every package; only the values below reach
// the browser. Secrets (demo funder key) stay server-side in the API route.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  transpilePackages: ["@behest/relayer"],
  env: {
    NEXT_PUBLIC_BEHEST_CONTRACT_ID: process.env.BEHEST_CONTRACT_ID ?? "behest-ekkr6.testnet",
    NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    NEXT_PUBLIC_RELAYER_URL: process.env.RELAYER_URL ?? "http://localhost:8787",
    // Never the private SEPOLIA_RPC_URL (it may embed an API key).
    NEXT_PUBLIC_SEPOLIA_RPC_URL: process.env.PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    // Public by design (WalletConnect project ids ship in every dapp); empty hides the phone-wallet option.
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.WALLETCONNECT_PROJECT_ID ?? "",
    // Public by design (Privy app ids ship in every app that uses it); empty hides email sign-in. The app secret stays with the notifier.
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.PRIVY_APP_ID ?? "",
  },
};
export default config;
