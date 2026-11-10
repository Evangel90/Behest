// One NEAR Connect instance per page. React runs effects twice in development,
// and a second connector (or one per screen) makes the Ethereum wallet ask
// MetaMask twice; MetaMask declines the second request ("a previous request is
// still active") and the connect window keeps showing that error.
// Its "Ethereum Wallets" entry (evm-on-near.dev) is left out: Ethereum wallets
// connect inside the app instead (src/lib/evm), with gas paid by Behest.
import type { NearConnector } from "@hot-labs/near-connect";

let connectorPromise: Promise<NearConnector> | null = null;

export function sharedConnector(): Promise<NearConnector> {
  if (!connectorPromise) {
    const p = import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network: "testnet", features: { testnet: true }, excludedWallets: ["ethereum-wallets"] }));
    p.catch(() => {
      if (connectorPromise === p) connectorPromise = null;
    });
    connectorPromise = p;
  }
  return connectorPromise;
}
