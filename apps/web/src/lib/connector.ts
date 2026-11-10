// One NEAR Connect instance per page. React runs effects twice in development,
// and a second connector (or one per screen) makes the Ethereum wallet ask
// MetaMask twice; MetaMask declines the second request ("a previous request is
// still active") and the connect window keeps showing that error.
import type { NearConnector } from "@hot-labs/near-connect";

let connectorPromise: Promise<NearConnector> | null = null;

export function sharedConnector(): Promise<NearConnector> {
  if (!connectorPromise) {
    const p = import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network: "testnet", features: { testnet: true }, excludedWallets: [] }));
    p.catch(() => {
      if (connectorPromise === p) connectorPromise = null;
    });
    connectorPromise = p;
  }
  return connectorPromise;
}
