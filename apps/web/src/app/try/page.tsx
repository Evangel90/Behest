"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/chrome";
import { Bracket, Button, ButtonLink, Card, ExtLink, Notice, StatusPill } from "@/components/ui";
import { ETH_EXPLORER } from "@/lib/config";
import { vaultAddress } from "@/lib/contract";
import { PERSONA_INFO, PERSONA_ROLES, clearSandbox, heirWallet, loadSandbox, saveSandbox, type Persona, type PersonaRole, type Sandbox } from "@/lib/demo";
import { humanError, usePlan } from "@/lib/hooks";
import { newKeyPair, personaSession, useSession } from "@/lib/session";

const MIN = 60_000;

export default function TryPage() {
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSandbox(loadSandbox());
    setLoaded(true);
  }, []);
  return (
    <AppShell>
        <div className="flex flex-col gap-3">
          <Bracket>Try as…</Bracket>
          <h1 className="text-[clamp(40px,6vw,72px)] font-medium leading-[0.92] tracking-[-0.045em]">Play every role.</h1>
          <p className="max-w-[720px] text-lg leading-relaxed">
            We'll create six real testnet accounts for you: Kemi the owner, three guardians and two heirs. Their keys stay in this browser. Timers are shortened so a whole release takes about five minutes.
          </p>
        </div>
        {loaded && (sandbox ? <SandboxView sandbox={sandbox} onReset={() => setSandbox(null)} /> : <CreateSandbox onCreated={setSandbox} />)}
      </AppShell>
  );
}

function CreateSandbox({ onCreated }: { onCreated: (s: Sandbox) => void }) {
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      setStep("Creating six testnet accounts…");
      const keys = Object.fromEntries(PERSONA_ROLES.map((r) => [r, newKeyPair()])) as Record<PersonaRole, ReturnType<typeof newKeyPair>>;
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKeys: Object.fromEntries(PERSONA_ROLES.map((r) => [r, keys[r].publicKey])) }),
      });
      const body = (await res.json()) as { accounts?: Record<PersonaRole, string>; error?: string };
      if (!res.ok || !body.accounts) throw new Error(body.error ?? "Couldn't create accounts.");
      const personas = Object.fromEntries(
        PERSONA_ROLES.map((r) => [r, { role: r, accountId: body.accounts![r], secretKey: keys[r].secretKey, ...PERSONA_INFO[r] } satisfies Persona]),
      ) as Record<PersonaRole, Persona>;
      const sandbox: Sandbox = { createdAt: Date.now(), personas, eth: { amara: heirWallet(), tobi: heirWallet() } };
      saveSandbox(sandbox);

      setStep("Kemi is writing the plan…");
      const kemi = personaSession(personas.owner);
      await kemi.call(
        "set_plan",
        {
          plan: {
            check_in_interval_ms: 2 * MIN,
            grace_ms: 0,
            waiting_period_ms: 2 * MIN,
            guardians: [personas.g1.accountId, personas.g2.accountId, personas.g3.accountId],
            quorum: 2,
            heirs: [
              { account_id: personas.amara.accountId, share_bps: 6000, near_destination: personas.amara.accountId, eth_destination: sandbox.eth.amara.address.toLowerCase() },
              { account_id: personas.tobi.accountId, share_bps: 4000, near_destination: personas.tobi.accountId, eth_destination: sandbox.eth.tobi.address.toLowerCase() },
            ],
          },
        },
        { deposit: 50_000_000_000_000_000_000_000n },
      );
      setStep("Kemi is putting 0.2 NEAR into the plan…");
      await kemi.call("deposit", { owner: personas.owner.accountId }, { deposit: 200_000_000_000_000_000_000_000n });
      onCreated(sandbox);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PERSONA_ROLES.map((r) => (
          <li key={r} className="rounded-tile border border-line p-3">
            <span className="font-semibold">{PERSONA_INFO[r].label}</span>
            <span className="block text-sm text-muted">{PERSONA_INFO[r].blurb}</span>
          </li>
        ))}
      </ul>
      {error && <Notice tone="error">{error}</Notice>}
      {step && <Notice>{step}</Notice>}
      <Button className="self-start" onClick={create} disabled={!!step}>
        {step ? "Setting up…" : "Create my test personas"}
      </Button>
      <p className="text-xs text-muted">Testnet NEAR only, from Behest's demo account. Heir Sepolia wallets are generated in your browser.</p>
    </Card>
  );
}

function SandboxView({ sandbox, onReset }: { sandbox: Sandbox; onReset: () => void }) {
  const router = useRouter();
  const { session, actAsPersona } = useSession();
  const owner = sandbox.personas.owner.accountId;
  const { view, chainNow } = usePlan(owner);
  const [vault, setVault] = useState<string | null>(null);
  useEffect(() => void vaultAddress(owner).then(setVault).catch(() => {}), [owner]);

  const actAs = (p: Persona) => {
    actAsPersona(p);
    router.push(`/plan/${owner}`);
  };
  const s = view?.status;
  const next: Record<string, { who: PersonaRole[]; text: string }> = {
    Active: { who: ["owner"], text: `Kemi is checking in. Wait until she's unreachable (${view ? Math.max(0, Math.ceil((view.overdue_at_ms - chainNow) / 1000)) : "…"} s), or act as Kemi to check in again.` },
    Overdue: { who: ["g1", "g2", "g3"], text: "Kemi is unreachable. Act as a guardian and propose a release." },
    Proposed: { who: ["g1", "g2", "g3", "owner"], text: "One more guardian needs to approve. Or act as Kemi and cancel." },
    Waiting: { who: ["owner", "amara"], text: "Approved. Kemi can still cancel until the waiting period ends; Amara will see when it's ready." },
    Eligible: { who: ["amara", "tobi"], text: "Ready. Act as Amara or Tobi and receive your share." },
    Executing: { who: ["amara", "tobi"], text: "Transfers are on their way. ETH needs a running executor (see below)." },
    Settled: { who: ["amara", "tobi"], text: "Done. Act as an heir to see receipts, or start over." },
  };
  const hint = s ? next[s] : null;

  return (
    <>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Bracket>Kemi's plan</Bracket>
          {s && <StatusPill status={s} />}
        </div>
        {hint && <p className="text-xl leading-snug">{hint.text}</p>}
        <Link href={`/plan/${owner}?view=inspect`} className="self-start text-sm underline underline-offset-4">
          Open the public inspector
        </Link>
      </Card>

      <section aria-label="Personas" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PERSONA_ROLES.map((r) => {
          const p = sandbox.personas[r];
          const current = session?.accountId === p.accountId;
          const suggested = hint?.who.includes(r);
          return (
            <div key={r} className={`flex flex-col gap-2 rounded-card border p-4 ${suggested ? "border-signal bg-s-approved" : "border-line bg-card"}`}>
              <span className="text-xl font-medium">{p.label}</span>
              <span className="text-sm">{p.blurb}</span>
              <span className="truncate font-mono text-[11px] text-muted" title={p.accountId}>
                {p.accountId}
              </span>
              <Button variant={current ? "outline" : "ink"} onClick={() => actAs(p)}>
                {current ? "Acting as them · open" : `Act as ${p.label.split(" ")[0]}`}
              </Button>
            </div>
          );
        })}
      </section>

      <Card className="flex flex-col gap-2">
        <Bracket>Optional: the Ethereum leg</Bracket>
        <p className="text-sm leading-relaxed">
          To see ETH released too, send a little Sepolia ETH (≥ 0.006) to Kemi's vault <strong>before</strong> a guardian proposes, and keep the executor running (<code className="font-mono">pnpm --filter @behest/executor start</code>). The executor broadcasts the transactions the contract had signed by the MPC network.
        </p>
        {vault && (
          <span className="break-all font-mono text-xs">
            vault <ExtLink href={`${ETH_EXPLORER}/address/${vault}`}>{vault}</ExtLink>
          </span>
        )}
        <span className="font-mono text-xs text-muted">
          heir wallets: Amara {sandbox.eth.amara.address} · Tobi {sandbox.eth.tobi.address}
        </span>
      </Card>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/plan/${owner}?view=inspect`} variant="outline">
          Inspector
        </ButtonLink>
        <Button
          variant="ghost"
          onClick={() => {
            if (confirm("Forget these personas? Their testnet accounts stay on chain, but this browser will lose their keys.")) {
              clearSandbox();
              onReset();
            }
          }}
        >
          Start over with new personas
        </Button>
      </div>
    </>
  );
}
