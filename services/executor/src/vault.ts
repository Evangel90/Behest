// Prints a plan's Sepolia vault address: pnpm vault <owner.testnet> [contract-id]
// The address comes from the MPC contract's derived key for (contract, path).
import { JsonRpcProvider } from "near-api-js";
import { ethAddressFromMpcKey } from "./near.js";

const [owner, contractId = process.env.BEHEST_CONTRACT_ID ?? "behest.testnet"] = process.argv.slice(2);
if (!owner) throw new Error("usage: pnpm vault <owner-account> [behest-contract-id]");
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const mpc = process.env.MPC_CONTRACT_ID ?? "v1.signer-prod.testnet";
const path = `behest/v1/${owner}/eth`;
const key = (await provider.callFunction({
  contractId: mpc,
  method: "derived_public_key",
  args: { path, predecessor: contractId, domain_id: 0 },
})) as string;
console.log(JSON.stringify({ owner, contractId, path, mpcKey: key, vault: ethAddressFromMpcKey(key) }, null, 2));
