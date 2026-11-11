"use client";
// Heir recovery packet: a printable page (and JSON file) with where the plan
// lives, what each heir receives and where, the timeline in words, and how to
// claim with or without Behest's website. Public data only; no keys.
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, FileQuestion, Printer, RotateCcw, WifiOff } from "lucide-react";
import { Mark } from "@/components/chrome";
import { QrCode } from "@/components/QrCode";
import { Button, ButtonLink, EmptyState, Skeleton, cx } from "@/components/ui";
import { BTC_EXPLORER, CONTRACT_ID, ETH_EXPLORER, NEAR_EXPLORER } from "@/lib/config";
import { getBtcDestinations, getBtcVault, getPlan, vaultAddress, view } from "@/lib/contract";
import { buildPacket, cliCommands, isEthImplicit, timelineWords, type Packet, type PacketHeir } from "@/lib/packet";
import { duration, shortName, when } from "@/lib/plan";
import type { PlanView, ReleaseOptions, ReleaseRules } from "@/lib/types";

export default function PacketPage() {
  return (
    <Suspense>
      <PacketScreen />
    </Suspense>
  );
}

interface Loaded {
  view: PlanView;
  packet: Packet;
}

function PacketScreen() {
  const owner = decodeURIComponent(useParams<{ owner: string }>().owner);
  const heir = useSearchParams().get("heir");
  const [data, setData] = useState<Loaded | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        setError(null);
        const v = await getPlan(owner);
        if (!v) return !off && setData(null);
        const [rules, options, dests, btc, eth] = await Promise.all([
          view<ReleaseRules | null>("get_release_rules", { owner }).catch(() => null),
          view<ReleaseOptions | null>("get_release_options", { owner }).catch(() => null),
          getBtcDestinations(owner).catch(() => []),
          getBtcVault(owner).catch(() => null),
          vaultAddress(owner).catch(() => null),
        ]);
        const packet = buildPacket(
          {
            contract: CONTRACT_ID,
            owner,
            version: v.plan.version,
            policy: v.plan.policy,
            rules,
            options,
            btcDestinations: dests,
            ethVault: eth,
            btcVault: btc?.address ?? null,
            appUrl: window.location.origin,
            generatedAt: Date.now(),
          },
          heir,
        );
        if (!off) setData({ view: v, packet });
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      off = true;
    };
  }, [owner, heir, attempt]);

  const download = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data.packet, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `behest-recovery-${owner}${heir ? `-${heir}` : ""}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
  };

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header data-print-hide className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-[860px] flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-8">
          <ButtonLink href={`/plan/${encodeURIComponent(owner)}`} variant="ghost" size="sm" icon={ArrowLeft}>
            Back to the plan
          </ButtonLink>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" icon={Download} disabled={!data} onClick={download}>
              Download JSON
            </Button>
            <Button variant="primary" size="sm" icon={Printer} disabled={!data} onClick={() => window.print()}>
              Print
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-[860px] flex-col gap-8 px-4 py-8 sm:px-8 print:max-w-none print:px-0 print:py-0">
        {data === undefined && !error && (
          <div aria-busy="true" aria-label="Loading the packet" className="flex flex-col gap-4">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-64 w-full rounded-card" />
          </div>
        )}
        {error && (
          <EmptyState icon={WifiOff} tone="error" title="Couldn't load the plan" body={`The NEAR network didn't answer: ${error}`}>
            <Button variant="ink" icon={RotateCcw} onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </Button>
          </EmptyState>
        )}
        {data === null && <EmptyState icon={FileQuestion} title={`No plan for ${owner}`} body="A recovery packet can only be made for a plan that exists." />}
        {data && data.packet.heirs.length === 0 && <EmptyState icon={FileQuestion} title={`${heir} isn't a heir of this plan`} body="Open the packet without a heir to see every heir." />}
        {data && data.packet.heirs.length > 0 && <PacketBody packet={data.packet} />}
      </main>
    </div>
  );
}

const ethAddr = (a: string) => `${ETH_EXPLORER}/address/${a}`;
const btcAddr = (a: string) => `${BTC_EXPLORER}/address/${a}`;
const nearAcct = (a: string) => `${NEAR_EXPLORER}/address/${a}`;

function PacketBody({ packet: pk }: { packet: Packet }) {
  const who = shortName(pk.owner);
  const words = useMemo(() => timelineWords(pk), [pk]);
  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5 text-sm font-semibold text-muted">
          <Mark size={22} />
          Behest recovery packet
        </div>
        <h1 className="text-[clamp(30px,6vw,44px)] font-medium leading-[1.02] tracking-[-0.04em]">
          {pk.heirs.length === 1 ? `For ${shortName(pk.heirs[0]!.account_id)}: your share of ${who}'s plan` : `${who}'s inheritance plan: what each heir needs`}
        </h1>
        <p className="max-w-[640px] text-[17px] leading-relaxed text-muted print:text-black">
          {who} uses Behest, a program on the NEAR blockchain that passes their digital assets to the people they chose if they stop checking in. This packet tells you where that plan lives,
          what is set aside for you, and how to receive it, with or without Behest&apos;s website. It contains no passwords or private keys, so it is safe to keep with a will or other papers.
        </p>
        <p className="text-sm text-muted">
          Made {when(Date.parse(pk.generated_at))} from plan version {pk.plan_version}. If {who} changes the plan, ask for a new copy.
        </p>
      </section>

      <Section title="Where the plan lives">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[180px_minmax(0,1fr)]">
          <Fact k="Network" v={pk.network === "testnet" ? "NEAR testnet (a test network: nothing here has real value)" : "NEAR mainnet"} />
          <Fact k="Behest contract" v={<A href={nearAcct(pk.contract)}>{pk.contract}</A>} mono />
          <Fact k="Plan owner" v={<A href={nearAcct(pk.owner)}>{pk.owner}</A>} mono />
          <Fact k="Plan version" v={String(pk.plan_version)} />
          {pk.vaults.ethereum && <Fact k="Ethereum vault" v={<A href={ethAddr(pk.vaults.ethereum)}>{pk.vaults.ethereum}</A>} mono />}
          {pk.vaults.bitcoin && <Fact k="Bitcoin vault" v={<A href={btcAddr(pk.vaults.bitcoin)}>{pk.vaults.bitcoin}</A>} mono />}
        </dl>
        <p className="text-sm leading-relaxed text-muted">
          The vaults are addresses only the contract can sign for (through NEAR Chain Signatures). Nobody, including Behest, holds a key that can move them outside the plan&apos;s rules.
        </p>
      </Section>

      <Section title="How a release happens">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-[15px] leading-relaxed marker:text-muted">
          {words.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ol>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">
            Guardians ({pk.guardians.quorum} of {pk.guardians.accounts.length} must agree)
          </span>
          <ul className="flex flex-wrap gap-1.5">
            {pk.guardians.accounts.map((g) => (
              <li key={g} className="rounded-full border border-line px-2.5 py-1 font-mono text-xs">
                {g}
              </li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted">
            Guardians are people {who} trusts to say they&apos;ve stopped hearing from them. They can propose and approve a release, but they can&apos;t choose who receives or how much. If you
            can&apos;t reach {who}, contacting a guardian is a good first step.
          </p>
        </div>
        {pk.delay_signers && (
          <p className="text-sm text-muted">
            Delay signers: <span className="font-mono text-xs">{pk.delay_signers.accounts.join(", ")}</span>
          </p>
        )}
      </Section>

      {pk.heirs.map((h) => (
        <HeirSection key={h.account_id} pk={pk} h={h} />
      ))}

      <Section title="Keeping your destinations safe">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed marker:text-muted">
          <li>Your share goes only to the addresses written in the plan. Keep the keys or recovery phrases for those wallets safe, and somewhere your family can find them.</li>
          <li>
            If you lose access to one, tell {who} while they can still update the plan. Once a release has started, nobody can change an address, not Behest, not the guardians, not
            {` ${who}`}.
          </li>
          <li>If the plan names an alternate or a fallback for a share nobody claims in time, that person can receive it instead (see your page above).</li>
          <li>
            <strong>Never share a recovery phrase or private key.</strong> Behest, guardians and heirs never need one from you, and nobody from Behest will ever ask for it.
          </li>
          <li>Money added to the plan after a release settles isn&apos;t lost: a heir or guardian can propose a follow-up round, and it is shared the same way.</li>
        </ul>
      </Section>

      <p className="pb-6 text-center text-xs text-muted">
        Behest · {pk.contract} · packet v{pk.packet_version} · generated {pk.generated_at}
      </p>
    </>
  );
}

function HeirSection({ pk, h }: { pk: Packet; h: PacketHeir }) {
  const name = shortName(h.account_id);
  const evm = isEthImplicit(h.account_id);
  const cmds = cliCommands(pk, h.account_id);
  const dests: [string, string | null, (a: string) => string][] = [
    ["NEAR", h.destinations.near, nearAcct],
    ["Ethereum", h.destinations.ethereum, ethAddr],
    ["Bitcoin", h.destinations.bitcoin, btcAddr],
  ];
  return (
    <section className={cx("flex flex-col gap-5 rounded-card border border-line bg-card p-5 sm:p-7 print:rounded-none print:border-0 print:p-0", "packet-page")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-muted">Heir</span>
          <h2 className="text-[28px] font-medium leading-tight tracking-[-0.03em]">{name}</h2>
          <span className="break-all font-mono text-xs text-muted">{h.account_id}</span>
        </div>
        <div className="flex items-center gap-3">
          <QrCode value={pk.plan_url} label={`QR code linking to ${pk.plan_url}`} className="size-24 text-ink print:text-black" />
          <span className="max-w-[160px] text-xs leading-snug text-muted">Scan to open the plan in the Behest app</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[24px] font-medium tracking-[-0.02em]">{h.share} of the plan</span>
        {h.fixed.length > 0 && <span className="text-[15px] text-muted">Plus, paid first: {h.fixed.join(" and ")}.</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Where it goes</span>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[120px_minmax(0,1fr)]">
          {dests.map(([k, v, link]) => (
            <Fact key={k} k={k} v={v ? <A href={link(v)}>{v}</A> : <span className="text-muted">not set: no {k} share for {name}</span>} mono={!!v} />
          ))}
        </dl>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">What {name} does</span>
        <ul className="flex flex-col gap-1.5 text-[15px] leading-relaxed">
          {h.modes.map((m) => (
            <li key={m.group}>
              <strong>{m.group === "Near" ? "NEAR and NEAR tokens" : m.group === "Ethereum" ? "ETH and tokens" : "Bitcoin"}:</strong> {m.text}
            </li>
          ))}
        </ul>
        {(h.alternate || h.fallback) && pk.timers.claim_window_ms != null && (
          <p className="text-sm leading-relaxed text-muted">
            If {name} doesn&apos;t claim within {duration(pk.timers.claim_window_ms)},
            {h.alternate ? ` the share can go to ${h.alternate.account_id}` : ""}
            {h.alternate && h.fallback ? ", and after that" : ""}
            {h.fallback ? ` to ${h.fallback.account_id}` : ""}.
          </p>
        )}
      </div>

      {h.mustClaim && (
        <div className="flex flex-col gap-3">
          <span className="text-sm font-semibold">How to claim</span>
          <ol className="flex list-decimal flex-col gap-3 pl-5 text-[15px] leading-relaxed marker:text-muted">
            <li>
              <strong>In the Behest app.</strong> Open <span className="break-all font-mono text-sm">{pk.plan_url}</span> (or scan the code), sign in as{" "}
              <span className="break-all font-mono text-sm">{h.account_id}</span>
              {evm ? " with the same Ethereum wallet (MetaMask or another) whose address this is. You sign a readable message; you don't need NEAR for fees." : " with your NEAR wallet. Behest pays the network fee."}{" "}
              Press &ldquo;Receive my share&rdquo; once the waiting period has ended.
            </li>
            <li>
              <strong>Without the Behest website.</strong> The contract is public, so any NEAR tool can call it.{" "}
              {evm
                ? "Your account is an Ethereum-wallet account, so the simplest route is any copy of the Behest app or another app that sends Behest's signed actions (evm_call). The read-only commands below still work for anyone."
                : "With near-cli-rs installed and your heir account's key in its keychain:"}
              <ul className="mt-2 flex flex-col gap-2">
                {cmds.filter((c) => !evm || !c.cmd.includes("as-transaction")).map((c) => (
                  <li key={c.label} className="flex flex-col gap-1">
                    <span className="text-sm text-muted">{c.label}</span>
                    <code className="block overflow-x-auto whitespace-pre-wrap break-all rounded-tile bg-subtle p-3 font-mono text-xs leading-relaxed print:bg-white print:p-0">{c.cmd}</code>
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <strong>If something goes wrong.</strong> A transfer that fails stays safe in the plan and can be retried by you or anyone, without paying twice. Network fees come from a
              reserve the plan holds, not from your share.
            </li>
          </ol>
        </div>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="border-b border-line pb-2 text-xl font-semibold tracking-[-0.02em]">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-sm text-muted">{k}</dt>
      <dd className={cx("min-w-0 break-all text-[15px]", mono && "font-mono text-[13px]")}>{v}</dd>
    </>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-signal-text underline decoration-line-strong underline-offset-2 print:text-black print:no-underline">
      {children}
    </a>
  );
}
