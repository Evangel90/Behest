// Wallets for people named by email. Privy creates an Ethereum, a NEAR and a
// Bitcoin wallet for an email address before that person has ever signed in;
// whoever later signs in with that address (a code sent to the inbox) gets
// exactly those wallets. The notifier only ever asks for addresses: it holds no
// key material, and the app secret used here can't sign for a user's wallet.
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

export interface EmailWallets {
  /** Privy's id for the user (did:privy:…). */
  userId: string;
  /** Lowercase 0x address: the account that signs Behest actions (D23). */
  eth: string;
  /** NEAR implicit account (64 hex chars). */
  near: string;
  /** SegWit (P2WPKH) address on this deployment's Bitcoin network. */
  btc: string;
}

/** Privy answered in a way that can't be used (bad key, outage, unexpected shape). */
export class PrivyError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

interface LinkedAccount {
  type: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
  wallet_client?: string;
  public_key?: string | null;
}
interface PrivyUser {
  id: string;
  linked_accounts?: LinkedAccount[];
}

const CHAINS = ["ethereum", "near", "bitcoin-segwit"] as const;

/** P2WPKH address of a compressed secp256k1 public key (hex), for mainnet (`bc`) or testnet (`tb`). */
export function segwitAddress(publicKeyHex: string, hrp: "bc" | "tb"): string {
  const pk = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
  if (pk.length !== 33 || (pk[0] !== 2 && pk[0] !== 3)) throw new PrivyError("unexpected Bitcoin public key");
  return bech32.encode(hrp, [0, ...bech32.toWords(ripemd160(sha256(pk)))]);
}

export class PrivyClient {
  private auth: string;
  constructor(
    private cfg: { appId: string; secret: string; apiBase: string; btcHrp: "bc" | "tb" },
    private fetchFn: typeof fetch = fetch,
  ) {
    this.auth = `Basic ${Buffer.from(`${cfg.appId}:${cfg.secret}`).toString("base64")}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiBase}${path}`, {
        method,
        headers: { authorization: this.auth, "privy-app-id": this.cfg.appId, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new PrivyError(`privy unreachable: ${(e as Error).message ?? String(e)}`);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  private embedded(u: PrivyUser, chain: string): LinkedAccount | undefined {
    return (u.linked_accounts ?? []).find((a) => a.type === "wallet" && a.chain_type === chain && (a.wallet_client_type ?? a.wallet_client) === "privy");
  }

  private async byEmail(email: string): Promise<PrivyUser | null> {
    const r = await this.call("POST", "/users/email/address", { address: email });
    if (r.status === 404) return null;
    if (r.status !== 200 || !(r.json as PrivyUser | null)?.id) throw new PrivyError(`privy lookup ${r.status}`, r.status);
    return r.json as PrivyUser;
  }

  /**
   * The wallets of the Privy user with this email, creating the user and any
   * missing wallet. Safe to repeat: the same email always gives the same addresses.
   */
  async ensure(email: string): Promise<EmailWallets> {
    let user = await this.byEmail(email);
    if (!user) {
      const r = await this.call("POST", "/users", { linked_accounts: [{ type: "email", address: email }], wallets: CHAINS.map((chain_type) => ({ chain_type })) });
      if (r.status === 200 && (r.json as PrivyUser | null)?.id) user = r.json as PrivyUser;
      // Lost a race with another request for the same address: read what it made.
      else user = await this.byEmail(email);
      if (!user) throw new PrivyError(`privy create ${r.status}`, r.status);
    }
    const missing = CHAINS.filter((c) => !this.embedded(user!, c));
    if (missing.length) {
      const r = await this.call("POST", `/users/${encodeURIComponent(user.id)}/wallets`, { wallets: missing.map((chain_type) => ({ chain_type })) });
      if (r.status !== 200 || !(r.json as PrivyUser | null)?.id) throw new PrivyError(`privy add wallets ${r.status}`, r.status);
      user = r.json as PrivyUser;
    }
    const eth = this.embedded(user, "ethereum")?.address ?? "";
    const near = this.embedded(user, "near")?.address ?? "";
    const btcKey = this.embedded(user, "bitcoin-segwit")?.public_key ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(eth) || !/^[0-9a-f]{64}$/.test(near) || !btcKey) throw new PrivyError("privy returned no usable wallets");
    return { userId: user.id, eth: eth.toLowerCase(), near, btc: segwitAddress(btcKey, this.cfg.btcHrp) };
  }
}
