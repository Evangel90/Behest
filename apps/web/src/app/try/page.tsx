"use client";
// Sandbox: six real testnet personas, so anyone can play every role of a
// release in about five minutes.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Eye, FlaskConical, Gift, KeyRound, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { useConfirm } from "@/components/feedback";
import { Address, Countdown, Disclosure } from "@/components/interactive";
import { Stagger, StaggerItem } from "@/components/motion";
import { Timeline } from "@/components/PlanParts";
import { Button, ButtonLink, Card, Notice, Skeleton, StatusPill, cx } from "@/components/ui";
import { ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { vaultAddress } from "@/lib/contract";
import { PERSONA_INFO, PERSONA_ROLES, clearSandbox, heirWallet, loadSandbox, saveSandbox, type Persona, type PersonaRole, type Sandbox } from "@/lib/demo";
import { humanError, usePlan } from "@/lib/hooks";
import { newKeyPair, personaSession, useSession } from "@/lib/session";
import { getTier, getTierConfig, mintTest, payFromWallet, payable } from "@/lib/tiers";

const MIN = 60_000;
const ROLE_ICON: Record<PersonaRole, typeof KeyRound> = { owner: KeyRound, g1: ShieldCheck, g2: ShieldCheck, g3: ShieldCheck, amara: Gift, tobi: Gift };
const roleAs = (r: PersonaRole) => (r === "owner" ? "owner" : r === "amara" || r === "tobi" ? "heir" : "guardian");

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
        <span className="flex items-center gap-1.5 text-sm font-semibold text-muted">
          <FlaskConical aria-hidden className="size-4" />
          Try as…
        </span>
        <h1 className="text-[clamp(40px,6vw,72px)] font-medium leading-[0.92] tracking-[-0.045em]">Play every role.</h1>
        <p className="max-w-[720px] text-lg leading-relaxed text-muted">
          We&apos;ll create six real testnet accounts: Kemi the owner, three guardians and two heirs. Their keys stay in this browser. Timers are shortened so a whole release takes about five minutes.
        </p>
      </div>
      {!loaded ? <Skeleton className="h-72 w-full rounded-card" /> : sandbox ? <SandboxView sandbox={sandbox} onReset={() => setSandbox(null)} /> : <CreateSandbox onCreated={setSandbox} />}
    </AppShell>
  );
}

const STEPS = ["Creating six testnet accounts", "Kemi is paying for the Standard tier in test USDC", "Kemi is writing the plan", "Kemi is putting 0.2 NEAR into the plan"];

function CreateSandbox({ onCreated }: { onCreated: (s: Sandbox) => void }) {
  const [step, setStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      setStep(0);
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

      setStep(1);
      const kemi = personaSession(personas.owner);
      // D25: two heirs with Ethereum destinations need Standard. Kemi takes
      // test USDC from the faucet and pays it, as any owner (or relative) would.
      const cfg = await getTierConfig();
      if (cfg.fee_token) {
        const t = await getTier(personas.owner.accountId);
        const due = payable(cfg, BigInt(t.due[1] ?? "0"), BigInt(t.paid));
        if (due > 0n) {
          await mintTest(kemi, cfg, personas.owner.accountId, due);
          await payFromWallet(kemi, cfg, personas.owner.accountId, due);
        }
      }
      setStep(2);
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
      setStep(3);
      await kemi.call("deposit", { owner: personas.owner.accountId }, { deposit: 200_000_000_000_000_000_000_000n });
      onCreated(sandbox);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <Card className="flex flex-col gap-5">
      <Stagger as="ul" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PERSONA_ROLES.map((r) => {
          const I = ROLE_ICON[r];
          return (
            <StaggerItem as="li" key={r} className="flex items-start gap-3 rounded-row border border-line p-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-subtle">
                <I aria-hidden className="size-[18px] text-muted" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold">{PERSONA_INFO[r].label}</span>
                <span className="text-sm leading-snug text-muted">{PERSONA_INFO[r].blurb}</span>
              </span>
            </StaggerItem>
          );
        })}
      </Stagger>
      {step !== null && (
        <ol role="status" aria-live="polite" className="flex flex-col gap-2 rounded-row bg-subtle p-4">
          {STEPS.map((label, i) => (
            <li key={label} className={cx("flex items-center gap-3 text-[15px]", i > step && "text-muted")}>
              <span className={cx("flex size-6 items-center justify-center rounded-full", i < step ? "bg-ok-bg text-ok" : i === step ? "bg-s-approved text-[var(--s-approved-fg)]" : "bg-card")}>
                {i < step ? <Check aria-hidden className="size-3.5" /> : i === step ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : null}
              </span>
              {label}
              {i === step && "…"}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <Notice tone="error" title="Setup didn't finish">
          {error}
        </Notice>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="primary" size="lg" icon={Sparkles} loading={step !== null} onClick={create}>
          {step !== null ? "Setting up…" : "Create my test personas"}
        </Button>
        <p className="text-xs text-muted sm:max-w-[360px] sm:text-right">Testnet NEAR only, from Behest&apos;s demo account. Heir Sepolia wallets are generated in your browser.</p>
      </div>
    </Card>
  );
}

function SandboxView({ sandbox, onReset }: { sandbox: Sandbox; onReset: () => void }) {
  const router = useRouter();
  const confirm = useConfirm();
  const { session, actAsPersona } = useSession();
  const owner = sandbox.personas.owner.accountId;
  const { view, chainNow } = usePlan(owner);
  const [vault, setVault] = useState<string | null>(null);
  useEffect(() => void vaultAddress(owner).then(setVault).catch(() => {}), [owner]);

  const actAs = (p: Persona) => {
    actAsPersona(p);
    router.push(`/plan/${encodeURIComponent(owner)}?as=${roleAs(p.role)}`);
  };
  const s = view?.status;
  const next: Record<string, { who: PersonaRole[]; text: string }> = {
    Active: { who: ["owner"], text: "Kemi is checking in. Wait until she's unreachable, or act as Kemi to check in again." },
    Overdue: { who: ["g1", "g2", "g3"], text: "Kemi is unreachable. Act as a guardian and propose a release." },
    Proposed: { who: ["g1", "g2", "g3", "owner"], text: "One more guardian needs to approve. Or act as Kemi and cancel." },
    Waiting: { who: ["owner", "amara"], text: "Approved. Kemi can still cancel until the waiting period ends; Amara will see when it's ready." },
    Eligible: { who: ["amara", "tobi"], text: "Ready. Act as Amara or Tobi and receive your share." },
    Executing: { who: ["amara", "tobi"], text: "Transfers are on their way. ETH needs a running executor (see below)." },
    Settled: { who: ["amara", "tobi"], text: "Done. Act as an heir to see receipts, or start over." },
  };
  const hint = s ? next[s] : null;

  const reset = async () => {
    if (
      await confirm({
        title: "Forget these personas?",
        body: "Their testnet accounts stay on chain, but this browser loses their keys. You can create a fresh set straight away.",
        confirmLabel: "Forget them",
        tone: "danger",
      })
    ) {
      clearSandbox();
      onReset();
    }
  };

  return (
    <>
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold text-muted">Kemi&apos;s plan · live</span>
          {s ? <StatusPill status={s} /> : <Skeleton className="h-7 w-24" />}
        </div>
        {hint ? (
          <p key={s} className="animate-fade-up text-[clamp(20px,2.6vw,26px)] font-medium leading-snug tracking-[-0.015em]">
            {hint.text}
          </p>
        ) : (
          <Skeleton className="h-8 w-3/4" />
        )}
        {view && s === "Active" && <Countdown to={view.overdue_at_ms} now={chainNow} prefix="Unreachable in " className="text-[15px] text-muted" />}
        {view && <Timeline view={view} now={chainNow} />}
      </Card>

      <section aria-label="Personas" className="flex flex-col gap-3">
        <h2 className="px-1 text-sm font-semibold text-muted">Act as…</h2>
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PERSONA_ROLES.map((r) => {
            const p = sandbox.personas[r];
            const current = session?.accountId === p.accountId;
            const suggested = hint?.who.includes(r);
            const I = ROLE_ICON[r];
            return (
              <StaggerItem key={r}>
                <div className={cx("flex h-full flex-col gap-3 rounded-card border p-4 transition-colors", suggested ? "border-signal bg-s-approved/60" : "border-line bg-card")}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex items-center gap-2.5">
                      <span className={cx("flex size-10 items-center justify-center rounded-full", suggested ? "bg-signal text-white" : "bg-subtle text-muted")}>
                        <I aria-hidden className="size-[18px]" />
                      </span>
                      <span className="text-lg font-semibold">{p.label}</span>
                    </span>
                    {suggested && <span className="rounded-tag bg-signal px-2 py-1 text-[11px] font-semibold text-white">Next up</span>}
                    {current && !suggested && <span className="rounded-tag bg-subtle px-2 py-1 text-[11px] font-semibold">Signed in</span>}
                  </div>
                  <span className="text-sm leading-snug text-muted">{p.blurb}</span>
                  <Address value={p.accountId} href={`${NEAR_EXPLORER}/address/${p.accountId}`} className="text-xs text-muted" label={`${p.label} account`} />
                  <Button variant={current ? "outline" : suggested ? "primary" : "ink"} iconRight={ArrowRight} className="mt-auto" onClick={() => actAs(p)}>
                    {current ? "Open as them" : `Act as ${p.label.split(" ")[0]}`}
                  </Button>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>

      <Disclosure icon={Wallet} title="Optional: the Ethereum leg" sub="Release Sepolia ETH too">
        <p className="text-sm leading-relaxed">
          Send a little Sepolia ETH (≥ 0.006) to Kemi&apos;s vault <strong>before</strong> a guardian proposes, and keep the executor running (<code className="font-mono">pnpm --filter @behest/executor start</code>). The executor broadcasts the transactions the contract had signed by the MPC network.
        </p>
        <div className="flex flex-col gap-2 text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Kemi&apos;s vault</span>
            {vault ? <Address value={vault} href={`${ETH_EXPLORER}/address/${vault}`} label="Kemi's vault" /> : <Skeleton className="h-4 w-36" />}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Amara&apos;s wallet</span>
            <Address value={sandbox.eth.amara.address} href={`${ETH_EXPLORER}/address/${sandbox.eth.amara.address}`} label="Amara's wallet" />
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Tobi&apos;s wallet</span>
            <Address value={sandbox.eth.tobi.address} href={`${ETH_EXPLORER}/address/${sandbox.eth.tobi.address}`} label="Tobi's wallet" />
          </span>
        </div>
      </Disclosure>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/plan/${encodeURIComponent(owner)}?view=inspect`} variant="outline" icon={Eye}>
          Public inspector
        </ButtonLink>
        <Button variant="ghost" icon={RotateCcw} onClick={reset}>
          Start over with new personas
        </Button>
      </div>
    </>
  );
}
