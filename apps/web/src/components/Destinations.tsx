"use client";
// D30 proof of control of a destination and D31 destination requests while
// the owner is active; owner account-recovery guidance. Proofs are evidence:
// they never block a release.
import { Explain } from "./more";
import { BadgeCheck, CircleAlert, Inbox, KeyRound, LifeBuoy, PenLine, Send, Undo2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isMissingMethod, view } from "@/lib/contract";
import { shortName, when } from "@/lib/plan";
import { useSession } from "@/lib/session";
import { CHAIN_LABEL, bip137, bitcoinMessageHash, proofHow, sigHex } from "@/lib/destinations";
import type { DestChain, DestinationView, PlanView } from "@/lib/types";
import { CopyButton, Disclosure, Field, Segmented } from "./interactive";
import { useTx } from "./tx";
import { Button, Card, Chip, Notice, SectionTitle, cx, inputClass } from "./ui";

export { CHAIN_LABEL };
const ETH = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface Destinations {
  loaded: boolean;
  supported: boolean;
  current: DestinationView[];
  requests: DestinationView[];
  reload: () => Promise<void>;
}

export function useDestinations(owner: string, key?: unknown): Destinations {
  const [s, set] = useState<Omit<Destinations, "reload">>({ loaded: false, supported: true, current: [], requests: [] });
  const reload = useCallback(async () => {
    try {
      const [current, requests] = await Promise.all([view<DestinationView[]>("get_destinations", { owner }), view<DestinationView[]>("get_destination_requests", { owner })]);
      set({ loaded: true, supported: true, current, requests });
    } catch (e) {
      set((x) => ({ ...x, loaded: true, supported: !isMissingMethod(e) && x.supported }));
    }
  }, [owner]);
  useEffect(() => void reload(), [reload, key]);
  return { ...s, reload };
}

function Proven({ d }: { d: DestinationView }) {
  return d.proven_at_ms ? (
    <Chip style={{ tone: "active", shape: "circle", label: "Proven" }}>
      Proven {when(d.proven_at_ms)}
    </Chip>
  ) : (
    <Chip style={{ tone: "waiting", shape: "square", label: "Not proven" }}>Not proven</Chip>
  );
}

/**
 * Proves one destination. NEAR: the signed-in account must be it.
 * Ethereum: an injected wallet signs, or a pasted signature. Bitcoin: a
 * pasted signed message (Electrum, Sparrow, Bitcoin Core `signmessage`).
 */
function ProveOne({ owner, d, me, onDone, compact }: { owner: string; d: DestinationView; me: string | null; onDone: () => unknown; compact?: boolean }) {
  const how = proofHow(d.chain, d.destination);
  const { busy, act } = useTx(onDone);
  const { session } = useSession();
  const emailNear = session?.email?.near;
  // Signed in as this very Ethereum address (a wallet, or an email's account): one click, no second wallet.
  const own = how === "eth" && !!session?.personalSign && session.accountId === d.destination.toLowerCase();
  // The Bitcoin address kept for the signed-in email: its key signs the message here, no Bitcoin wallet needed.
  const ownBtc = how === "btc" && session?.email?.btc === d.destination;
  const [msg, setMsg] = useState<string | null>(null);
  const [sig, setSig] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [wallets, setWallets] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (how === "near" || how === "taproot") return;
    void view<string>("get_proof_message", { owner, account_id: d.account_id, chain: d.chain, destination: d.destination }).then(setMsg, () => setMsg(null));
    if (how === "eth") void import("@/lib/evm/wallets").then((w) => setWallets(w.injectedWallets().map((x) => ({ id: x.info.id, name: x.info.name }))));
  }, [owner, d, how]);
  const args = (signature: string | null) => ({ owner, account_id: d.account_id, chain: d.chain, destination: d.destination, signature });
  const label = `Prove ${CHAIN_LABEL[d.chain]} address`;
  const done = "Proven. Everyone on the plan can see this address is under the heir's control.";

  if (how === "taproot") return <p className="text-sm text-muted">Taproot (tb1p…) addresses can't be proven yet. A tb1q address can.</p>;
  if (how === "near")
    return me === d.destination ? (
      <Button size="sm" variant="primary" icon={BadgeCheck} loading={busy === label} disabled={!!busy} onClick={() => void act(label, "prove_destination", args(null), { done })}>
        Prove I control {shortName(d.destination)}
      </Button>
    ) : (
      <p className="text-sm text-muted">
        {emailNear === d.destination ? (
          "This is the NEAR account kept for your email. Only your sign-in can move what arrives here."
        ) : (
          <>
            Sign in to Behest as <span className="break-all font-mono">{d.destination}</span> and open this plan to prove it.
          </>
        )}
      </p>
    );

  async function withWallet(id: string) {
    setErr(null);
    try {
      const w = await import("@/lib/evm/wallets");
      const c = await w.connect(id);
      if (c.address !== d.destination.toLowerCase()) return setErr(`That wallet is on ${c.address}. Switch to ${d.destination} and try again.`);
      const s = await c.sign(msg!);
      await act(label, "prove_destination", args(s), { done });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function withSession() {
    setErr(null);
    try {
      await act(label, "prove_destination", args(await session!.personalSign!(msg!)), { done });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function withEmailBtc() {
    setErr(null);
    try {
      const w = session!.email!;
      const digest = bitcoinMessageHash(msg!);
      const signature = bip137(await w.signBtc(digest), digest, w.btcPublicKey);
      if (!signature) return setErr("The sign-in service's signature doesn't match this address. Nothing was sent.");
      await act(label, "prove_destination", args(signature), { done });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function pasted() {
    const s = how === "eth" ? (/^0x[0-9a-fA-F]{130}$/.test(sig.trim()) ? sig.trim() : null) : sigHex(sig);
    if (!s) return setErr(how === "eth" ? "That isn't a 65-byte 0x… signature." : "That isn't a Bitcoin signed-message signature (base64 or hex).");
    setErr(null);
    if (await act(label, "prove_destination", args(s), { done })) setSig("");
  }

  return (
    <div className={cx("flex flex-col gap-3", !compact && "border-t border-line pt-3")}>
      {(own || ownBtc) && msg && (
        <Button size="sm" variant="primary" icon={BadgeCheck} className="self-start" loading={busy === label} disabled={!!busy} onClick={() => void (own ? withSession() : withEmailBtc())}>
          Prove this address is mine
        </Button>
      )}
      {how === "eth" && !own && wallets.length > 0 && msg && (
        <div className="flex flex-wrap gap-2">
          {wallets.map((w) => (
            <Button key={w.id} size="sm" variant="primary" icon={Wallet} disabled={!!busy} onClick={() => void withWallet(w.id)}>
              Sign with {w.name}
            </Button>
          ))}
        </div>
      )}
      <Disclosure icon={PenLine} title={how === "btc" ? "Sign this message in your Bitcoin wallet" : "Or sign in another wallet and paste the signature"} sub={how === "btc" ? "Electrum, Sparrow or Bitcoin Core: Sign message, with this address" : "Any wallet's “Sign message” (personal_sign)"}>
        <div className="flex flex-col gap-3">
          {msg && (
            <div className="relative">
              <pre className="whitespace-pre-wrap rounded-lg bg-subtle p-3 pr-20 font-mono text-[12px] leading-relaxed">{msg}</pre>
              <CopyButton value={msg} className="absolute right-2 top-2" />
            </div>
          )}
          <Field label="Signature" error={err}>
            {(c) => <textarea {...c} rows={2} className={cx(inputClass, "font-mono text-[12px]")} value={sig} onChange={(e) => setSig(e.target.value)} spellCheck={false} placeholder={how === "btc" ? "H8x…= (base64)" : "0x…"} />}
          </Field>
          <Button size="sm" variant="outline" className="self-start" disabled={!sig || !!busy} loading={busy === label} onClick={() => void pasted()}>
            Submit proof
          </Button>
        </div>
      </Disclosure>
      {err && !sig && <p className="text-sm text-error">{err}</p>}
    </div>
  );
}

// ------------------------------------------------------------ heir side

/** A recipient's own destinations: prove them, and ask the owner for a new one while the owner is active. */
export function MyDestinationsCard({ planView, me, dest }: { planView: PlanView; me: string; dest: Destinations }) {
  const owner = planView.plan.owner;
  const mine = dest.current.filter((d) => d.account_id === me);
  const asked = dest.requests.filter((d) => d.account_id === me);
  const active = planView.status === "Active";
  const { busy, act } = useTx(dest.reload);
  const chains = (["Near", "Eth", "Btc", "Intents"] as DestChain[]).filter((c) => c !== "Intents" || mine.some((d) => d.chain === "Intents"));
  const [chain, setChain] = useState<DestChain>("Near");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!dest.supported || (!mine.length && !asked.length && !active)) return null;

  async function request() {
    const a = to.trim();
    const ok = chain === "Eth" ? ETH.test(a) : chain === "Btc" ? /^(tb1|bc1)[a-z0-9]{8,87}$/.test(a) : ETH.test(a) || (ACCOUNT.test(a) && a.length >= 2 && a.length <= 64);
    if (!ok) return setErr(`That isn't a ${CHAIN_LABEL[chain]} address.`);
    setErr(null);
    const self = proofHow(chain, a) === "near" && a === me;
    const r = await act("Ask for a new address", "request_destination_change", { owner, chain, destination: chain === "Eth" ? a.toLowerCase() : a, signature: null }, { done: `Sent. ${shortName(owner)} decides; nothing changes until they approve.${self ? " It's proven, since it's the account you're signed in with." : " Prove it below so they know it's yours."}` });
    if (r) setTo("");
  }

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={KeyRound} title="Where you receive" sub={`Prove you control each address, so ${shortName(owner)} and the guardians know it still works. A proof never holds a release back.`} />
      <ul className="flex flex-col gap-3">
        {mine.map((d) => (
          <li key={d.chain} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{CHAIN_LABEL[d.chain]}</div>
                <div className="break-all font-mono text-[13px] text-muted">{d.destination}</div>
              </div>
              <Proven d={d} />
            </div>
            {!d.proven_at_ms && <ProveOne owner={owner} d={d} me={me} onDone={dest.reload} />}
          </li>
        ))}
      </ul>
      {asked.map((d) => (
        <Notice
          key={d.chain}
          tone="info"
          title={`You asked to receive ${CHAIN_LABEL[d.chain]} at a new address`}
          action={
            <Button size="sm" variant="subtle" icon={Undo2} disabled={!!busy} onClick={() => void act("Withdraw the request", "cancel_destination_change", { owner, chain: d.chain }, { done: "Withdrawn." })}>
              Withdraw
            </Button>
          }
        >
          <span className="break-all font-mono text-[13px]">{d.destination}</span> · waiting for {shortName(owner)}. {d.proven_at_ms ? "Proven." : "Not proven yet:"}
          {!d.proven_at_ms && <ProveOne owner={owner} d={d} me={me} onDone={dest.reload} compact />}
        </Notice>
      ))}
      {active ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="text-sm font-medium">Lost access to an address, or want a new one?</div>
          <Segmented size="sm" label="Network" options={chains.map((c) => ({ value: c, label: CHAIN_LABEL[c] }))} value={chain} onChange={setChain} />
          <Field label="New address" hint={`${shortName(owner)} has to approve it; if they set an edit notice, it waits that long too.`} error={err}>
            {(c) => <input {...c} className={cx(inputClass, "font-mono text-[13px]")} value={to} onChange={(e) => setTo(e.target.value)} placeholder={chain === "Btc" ? "tb1q…" : chain === "Eth" ? "0x…" : "new-wallet.testnet"} autoComplete="off" spellCheck={false} />}
          </Field>
          <Button variant="outline" icon={Send} className="self-start" disabled={!to || !!busy} onClick={() => void request()}>
            Ask {shortName(owner)}
          </Button>
        </div>
      ) : (
        <Explain label="When requests are possible">New addresses can only be requested while {shortName(owner)} is active. If a registered address no longer works, the plan&apos;s alternates or fallback decide where that share goes.</Explain>
      )}
    </Card>
  );
}

/** For someone signed in as a registered NEAR destination (not a plan member): one button to prove it. */
export function ProveAsDestinationCard({ owner, me, dest }: { owner: string; me: string | null; dest: Destinations }) {
  const rows = [...dest.current, ...dest.requests].filter((d) => d.destination === me && !d.proven_at_ms);
  if (!me || !rows.length) return null;
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={BadgeCheck} title="This account receives from the plan" sub={`Prove you control it, for ${rows.map((d) => shortName(d.account_id)).join(", ")}.`} />
      {rows.map((d) => (
        <ProveOne key={`${d.account_id}:${d.chain}`} owner={owner} d={d} me={me} onDone={dest.reload} compact />
      ))}
    </Card>
  );
}

// ------------------------------------------------------------ owner side

/** Proof status of every destination, and recipients' requests to approve or reject. */
export function DestinationsOwnerCard({ planView, dest, notice, editable, onChanged }: { planView: PlanView; dest: Destinations; notice: number; editable: boolean; onChanged?: () => unknown }) {
  const { busy, act } = useTx(async () => {
    await dest.reload();
    await onChanged?.();
  });
  if (!dest.supported || (!dest.current.length && !dest.requests.length)) return null;
  const proven = dest.current.filter((d) => d.proven_at_ms).length;
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={Inbox}
        title="Heirs' addresses"
        aside={<Chip style={{ tone: proven === dest.current.length ? "active" : "waiting", shape: proven === dest.current.length ? "circle" : "square", label: "proofs" }}>{`${proven} of ${dest.current.length} proven`}</Chip>}
        sub="A proven address was signed for by the heir. Unproven ones may still work; ask the heir to prove them from their plan page."
      />
      {dest.requests.map((d) => {
        const cur = dest.current.find((x) => x.account_id === d.account_id && x.chain === d.chain);
        const key = `${d.account_id}:${d.chain}`;
        return (
          <Notice key={key} tone={d.proven_at_ms ? "info" : "warn"} title={`${shortName(d.account_id)} asks to receive ${CHAIN_LABEL[d.chain]} at a new address`}>
            <div className="flex flex-col gap-2">
              <div className="break-all font-mono text-[13px]">
                {cur ? `${cur.destination} → ` : ""}
                {d.destination}
              </div>
              <div className="text-sm">{d.proven_at_ms ? "They proved they control it." : "Not proven yet. If you weren't expecting this, check with them another way before approving."}</div>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === `Approve ${key}`}
                    disabled={!!busy}
                    onClick={() => void act(`Approve ${key}`, "respond_destination_change", { account_id: d.account_id, chain: d.chain, approve: true }, { deposit: 10n ** 22n, done: notice ? "Approved. It takes effect when your edit notice ends." : "Approved and saved." })}
                  >
                    Approve
                  </Button>
                  <Button size="sm" variant="subtle" disabled={!!busy} onClick={() => void act(`Reject ${key}`, "respond_destination_change", { account_id: d.account_id, chain: d.chain, approve: false }, { done: "Rejected. Their address is unchanged." })}>
                    Reject
                  </Button>
                </div>
              )}
            </div>
          </Notice>
        );
      })}
      <ul className="flex flex-col divide-y divide-line">
        {dest.current.map((d) => (
          <li key={`${d.account_id}:${d.chain}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="text-sm">
                {shortName(d.account_id)} · {CHAIN_LABEL[d.chain]}
              </div>
              <div className="break-all font-mono text-[12px] text-muted">{d.destination}</div>
            </div>
            <Proven d={d} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** D31 guidance: the plan follows the owner's account, so keep that account recoverable. */
export function AccountRecoveryCard({ owner, kind, notice }: { owner: string; kind?: string; notice: number }) {
  const evm = /^0x[0-9a-f]{40}$/.test(owner);
  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={LifeBuoy} title="If you lose access to your account" sub="Your plan follows your account. Behest can't hand it to anyone else, so keep a way back in." />
      <Explain label="What to do">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-ink">
        {evm ? (
          <>
            <li>Your plan is controlled by an Ethereum wallet. It can&apos;t have a second key, so keep its recovery phrase written down somewhere safe and separate.</li>
            <li>For more resilience, an organisation or family can own the plan through a NEAR DAO with several members.</li>
          </>
        ) : kind === "dao" ? (
          <li>A DAO owns this plan: losing one member&apos;s key is fine as long as the council can still reach its approval threshold. Keep the member list current.</li>
        ) : (
          <>
            <li>Add a second full-access key to {shortName(owner)} (a hardware wallet or a recovery phrase in a safe place). Either key can then sign in and check in.</li>
            <li>Never share a recovery phrase with Behest, guardians or heirs. Nobody on the plan needs it.</li>
          </>
        )}
        <li>Add a check-in delegate under Plan and fees: someone who can check in for you if you&apos;re locked out for a while. They can&apos;t edit or withdraw.</li>
        <li>{notice ? "Your edit notice is on: if someone else gets your key and changes heirs or destinations, guardians and heirs are told and you have time to cancel." : "Turn on an edit notice above: if someone else gets your key and changes heirs or destinations, guardians and heirs are told and you have time to cancel."}</li>
        <li>If you can&apos;t get back in, the plan does what it says: after the missed check-ins and the waiting period, guardians can start the release to your heirs.</li>
        </ul>
      </Explain>
      {!notice && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleAlert className="size-4" aria-hidden /> The edit notice is the strongest protection against a stolen key.
        </p>
      )}
    </Card>
  );
}
