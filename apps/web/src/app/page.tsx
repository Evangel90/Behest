import Link from "next/link";
import { AccountButton, Logo, TestnetBar } from "@/components/chrome";
import { InspectForm } from "@/components/InspectForm";
import { ButtonLink } from "@/components/ui";

const STEPS = [
  { n: "01", c: "var(--color-s-active)", t: "Set your rules", b: "Heirs, shares and fixed addresses per chain; guardians and how many must agree; a check-in schedule and a waiting period.", s: "Active" },
  { n: "02", c: "var(--color-s-active)", t: "Check in", b: "One tap every few months. Each check-in adds a ring. Nothing else changes while you're around.", s: "Active" },
  { n: "03", c: "var(--color-s-overdue)", t: "Owner unreachable", b: "A missed check-in plus a grace period. Nothing moves yet.", s: "Overdue" },
  { n: "04", c: "var(--color-s-waiting)", t: "Approve, then wait", b: "Guardians approve one exact proposal. A waiting period follows; you can cancel until it ends.", s: "Waiting" },
  { n: "05", c: "var(--color-s-eligible)", t: "Heirs receive", b: "Each share goes to its fixed address. Network fees come from the plan; heirs pay no gas. Receipts on every chain.", s: "Eligible" },
];

const COLS = ["Owner", "Guardians", "Heirs", "Executors", "Gas relayer"];
const Y = { sym: "✓", cls: "bg-mint text-ink", sr: "can" };
const N = { sym: "✕", cls: "border-[1.5px] border-line text-muted", sr: "cannot" };
const P = { sym: "◐", cls: "bg-testnet text-ink", sr: "partly" };
const M = { y: Y, n: N, p: P } as const;
const ROWS: [string, string][] = [
  ["Set heirs, amounts, destinations", "ynnnn"],
  ["Check in / cancel before the cutoff", "ynnnn"],
  ["Propose a release", "nynnn"],
  ["Approve a specific proposal", "nynnn"],
  ["Receive after eligibility", "nnynn"],
  ["Broadcast a signed transfer", "nnpyn"],
  ["Pay NEAR gas for others", "nnnny"],
];

const SAFETY = [
  { t: "Non-custodial.", b: "Funds sit in escrow and in addresses your plan's contract controls. Behest never holds keys." },
  { t: "Cancel until the cutoff.", b: "Until the waiting period ends, one action from you stops any release." },
  { t: "No redirects.", b: "Guardians, executors and the gas relayer can't change recipients, amounts or addresses." },
  { t: "Rules are public.", b: "Every plan's rules are on-chain and readable, in plain words and in code." },
  { t: "Failures are visible.", b: "If a transfer fails you see why, that the funds are safe, and who can retry." },
];

const LIMITS = [
  { t: "Not a will", b: "Pair it with legal estate planning that refers to it." },
  { t: "Doesn't determine death", b: "It only knows check-ins stopped. Guardians decide whether to propose." },
  { t: "Public by default", b: "Rules and heir addresses are on-chain. A private mode is planned for Stage 3." },
  { t: "Testnet today", b: "Unaudited. NEAR and Sepolia ETH only; Bitcoin and tokens come later. Owners can't withdraw ETH from the vault yet." },
];

const ROAD = [
  { n: 1, tag: "NOW", t: "Testnet MVP", b: "Plans, check-ins, quorum, waiting period, heir claims, sponsored gas." },
  { n: 2, tag: "NEXT", t: "Richer rules", b: "Delay signers, claim modes, versions, recovery packet, ETH withdrawals." },
  { n: 3, tag: "PLANNED", t: "Guided & private", b: "Presets, cooling-off, guardian rotation, private mode." },
  { n: 4, tag: "PLANNED", t: "Mainnet", b: "Audits, value caps, allowlists, pause transparency." },
  { n: 5, tag: "VISION", t: "Full vision", b: "Policy builder, attestors, Bitcoin and token adapters." },
];

const FAQ = [
  { q: "What if I forget to check in?", a: "Nothing can start until you're overdue and the grace period has passed. Even after guardians propose, you can cancel or check in until the waiting period ends." },
  { q: "Could guardians team up and take the funds?", a: "No. They can only approve releasing the plan exactly as written, to your heirs' fixed addresses." },
  { q: "Do heirs need crypto experience?", a: "They need the wallet address you recorded. Heir pages are in plain language, network fees come from the plan, and Behest pays their NEAR gas." },
  { q: "What if Behest disappears?", a: "Rules live on-chain and executors are permissionless: every signed transfer is public and anyone can broadcast it." },
  { q: "What does it cost?", a: "On testnet nothing real. Network fees come out of the plan's own balance and are shown before anything is signed." },
];

export default function Landing() {
  return (
    <div className="bg-paper">
      <TestnetBar />
      <header className="mx-auto flex max-w-[1360px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Logo />
        <nav aria-label="Sections" className="hidden gap-1 text-[15px] font-medium md:flex">
          {[["#how", "How it works"], ["#roles", "Roles"], ["#safety", "Safety"], ["#roadmap", "Roadmap"], ["/inspect", "Inspect"]].map(([h, l]) => (
            <a key={h} href={h} className="rounded-full px-3.5 py-3 hover:bg-line-soft">
              {l}
            </a>
          ))}
        </nav>
        <AccountButton />
      </header>

      <main>
        <section className="mx-auto flex max-w-[1360px] flex-col gap-9 px-4 pb-[clamp(48px,8vw,104px)] pt-[clamp(40px,8vw,96px)] sm:px-6">
          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-muted">[ Non-custodial inheritance · built on NEAR ]</span>
          <h1 className="font-display text-[clamp(56px,12vw,184px)] font-bold leading-[0.88] tracking-[-0.055em]">
            Your <span className="inline-block rounded-full bg-mint px-[0.18em]">behest</span>,<br />
            honoured by code.
          </h1>
          <div className="flex flex-wrap items-end justify-between gap-8 border-t border-ink pt-7">
            <p className="max-w-[620px] text-[clamp(18px,1.8vw,22px)] leading-[1.45]">
              Decide who receives your NEAR and Ethereum. If you stop checking in, guardians can start a release that only pays the addresses you chose — and you can cancel until the last moment.
            </p>
            <div className="flex flex-wrap gap-2.5">
              <ButtonLink href="/try" className="min-h-[60px] px-8 text-[17px]">
                Try it on testnet
              </ButtonLink>
              <ButtonLink href="#how" variant="outline" className="min-h-[60px] px-8 text-[17px]">
                See how it works
              </ButtonLink>
            </div>
          </div>
        </section>

        <div className="overflow-hidden whitespace-nowrap bg-ink py-4 text-mint" aria-hidden="true">
          <div className="marquee inline-block text-[15px] font-bold uppercase tracking-[0.06em]">
            {Array.from({ length: 2 }, (_, k) => (
              <span key={k}>
                {["Non-custodial", "Cancel until cutoff", "No redirects", "Heirs need no gas", "Rules on-chain", "NEAR · ETH"].map((t) => (
                  <span key={t} className="px-6">
                    {t} <span className="pl-6">✱</span>
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>

        <section className="mx-auto flex max-w-[1360px] flex-wrap gap-12 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-4">
            <span className="font-mono text-[13px] font-bold uppercase">[ 01 ] The problem</span>
            <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">Keys die with their holders.</h2>
          </div>
          <div className="grid min-w-0 flex-[1.4_1_520px] grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            {[
              ["CUSTODIAL", "Someone else holds the keys", "Counterparty risk, and trust in a company outliving you.", "bg-card"],
              ["FRAGILE", "A seed phrase in a drawer", "Lost, found too early, or never understood by family.", "bg-card"],
              ["BEHEST", "Rules, not middlemen", "You keep control. A public contract enforces who, how much, where and when.", "bg-mint"],
            ].map(([k, t, b, bg]) => (
              <div key={k} className={`flex flex-col gap-2.5 rounded-card border-[1.5px] border-ink p-6 ${bg}`}>
                <span className="font-mono text-xs font-bold">{k}</span>
                <span className="font-display text-2xl font-bold leading-tight tracking-[-0.02em]">{t}</span>
                <span className="text-[15px] leading-normal">{b}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="void bg-void text-paper">
          <div className="mx-auto flex max-w-[1360px] flex-col gap-10 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">Five steps. One promise.</h2>
              <span className="font-mono text-[13px] font-bold uppercase text-muted-dark">[ 02 ] How it works</span>
            </div>
            <ol className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
              {STEPS.map((s) => (
                <li key={s.n} className="flex flex-col gap-3 rounded-card border border-line-dark bg-panel p-5">
                  <span className="font-mono text-xs font-bold" style={{ color: s.c }}>
                    [ {s.n} ]
                  </span>
                  <span className="font-display text-2xl font-bold tracking-[-0.02em]">{s.t}</span>
                  <span className="flex-1 text-[15px] leading-normal text-[#C9C8C1]">{s.b}</span>
                  <span className="self-start rounded-full px-2.5 py-1 font-mono text-[11px] font-bold uppercase text-ink" style={{ background: s.c }}>
                    {s.s}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="roles" className="mx-auto flex max-w-[1360px] flex-col gap-8 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">Everyone has a job. Nobody can redirect.</h2>
            <span className="font-mono text-[13px] font-bold uppercase">[ 03 ] Roles &amp; boundaries</span>
          </div>
          <div className="overflow-x-auto rounded-card border-[1.5px] border-ink bg-card">
            <table className="w-full min-w-[720px] border-collapse text-left text-[15px]">
              <thead>
                <tr className="border-b-[1.5px] border-ink">
                  <th scope="col" className="p-4 font-mono text-xs font-bold uppercase">Action</th>
                  {COLS.map((c) => (
                    <th key={c} scope="col" className="p-4 text-center font-mono text-xs font-bold uppercase">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([a, cells]) => (
                  <tr key={a} className="border-b border-line">
                    <th scope="row" className="p-4 font-normal">{a}</th>
                    {cells.split("").map((c, i) => {
                      const m = M[c as keyof typeof M];
                      return (
                        <td key={i} className="p-3 text-center">
                          <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${m.cls}`} aria-label={`${COLS[i]} ${m.sr}`}>
                            {m.sym}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="bg-[#FFF1EF]">
                  <th scope="row" className="p-4 font-bold">Change where funds go</th>
                  {COLS.map((c) => (
                    <td key={c} className="p-3 text-center">
                      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${N.cls}`} aria-label={`${c} cannot`}>
                        ✕
                      </span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted">Only the owner sets destinations, and only while no release is open. ◐ Heirs can broadcast their own signed transfer; so can anyone.</p>
        </section>

        <section id="safety" className="border-y-[1.5px] border-ink bg-mint">
          <div className="mx-auto flex max-w-[1360px] flex-col gap-8 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
            <span className="font-mono text-[13px] font-bold uppercase">[ 04 ] Safety principles</span>
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-8 gap-y-6">
              {SAFETY.map((s) => (
                <li key={s.t} className="flex flex-col gap-2 border-t-[1.5px] border-ink pt-4">
                  <span className="font-display text-[28px] font-bold leading-none tracking-[-0.03em]">{s.t}</span>
                  <span className="text-[15px] leading-normal">{s.b}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="void bg-void text-paper">
          <div className="mx-auto flex max-w-[1360px] flex-wrap gap-12 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
            <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-5">
              <span className="font-mono text-[13px] font-bold uppercase text-muted-dark">[ 05 ] Chain Signatures</span>
              <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">One account. Every chain.</h2>
              <p className="max-w-[560px] text-lg leading-relaxed text-[#C9C8C1]">
                Your plan lives on NEAR and controls a derived Ethereum address through NEAR Chain Signatures. No bridges, no wrapped tokens. The contract builds each transfer itself, so the MPC network can only ever sign the exact payment your plan allows.
              </p>
            </div>
            <div className="flex min-w-0 flex-[1_1_420px] flex-col justify-center gap-3 rounded-card border border-line-dark bg-panel p-6 font-mono text-sm">
              <span className="text-muted-dark">kemi.testnet · plan contract</span>
              {[
                ["NEAR", "var(--color-s-active)", "escrow in behest-ekkr6.testnet"],
                ["ETH", "var(--color-s-approved)", "vault 0x… derived from behest/v1/kemi.testnet/eth"],
                ["BTC", "var(--color-s-cancelled)", "planned (Stage 5)"],
              ].map(([k, c, a]) => (
                <div key={k} className="flex flex-wrap items-center gap-3 border-t border-line-dark pt-3">
                  <span className="rounded-full px-2.5 py-1 text-xs font-bold text-ink" style={{ background: c }}>
                    {k}
                  </span>
                  <span className="min-w-0 break-all text-paper">{a}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto flex max-w-[1360px] flex-col gap-8 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">What Behest isn't.</h2>
            <span className="font-mono text-[13px] font-bold uppercase">[ 06 ] Honest limits</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
            {LIMITS.map((l) => (
              <div key={l.t} className="flex flex-col gap-2 rounded-card border-[1.5px] border-ink bg-card p-6">
                <span className="font-display text-2xl font-bold tracking-[-0.02em]">{l.t}</span>
                <span className="text-[15px] leading-normal text-muted">{l.b}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="roadmap" className="void bg-void text-paper">
          <div className="mx-auto flex max-w-[1360px] flex-col gap-8 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">Shipping in public.</h2>
              <span className="font-mono text-[13px] font-bold uppercase text-muted-dark">[ 07 ] Roadmap</span>
            </div>
            <ol className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
              {ROAD.map((r) => (
                <li
                  key={r.n}
                  aria-current={r.n === 1 ? "step" : undefined}
                  className={`flex flex-col gap-2 rounded-card border p-5 ${r.n === 1 ? "border-mint bg-mint text-ink" : "border-line-dark bg-panel"}`}
                >
                  <span className="font-mono text-xs font-bold">
                    STAGE {r.n} · {r.tag}
                  </span>
                  <span className="font-display text-2xl font-bold tracking-[-0.02em]">{r.t}</span>
                  <span className={`text-sm leading-normal ${r.n === 1 ? "" : "text-[#C9C8C1]"}`}>{r.b}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto grid max-w-[1360px] gap-10 px-4 py-[clamp(64px,9vw,120px)] sm:px-6 lg:grid-cols-[1fr_1.4fr]">
          <h2 className="font-display text-[clamp(40px,5.5vw,80px)] font-bold leading-[0.95] tracking-[-0.045em]">FAQ</h2>
          <div className="flex flex-col">
            {FAQ.map((f) => (
              <details key={f.q} className="group border-t-[1.5px] border-ink py-5 last:border-b-[1.5px]">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-display text-xl font-bold tracking-[-0.01em]">
                  {f.q}
                  <span className="text-2xl transition-transform duration-[240ms] ease-ledger group-open:rotate-45" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p className="pt-3 text-base leading-relaxed text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="border-t-[1.5px] border-ink">
          <div className="mx-auto flex max-w-[1360px] flex-col gap-8 px-4 py-[clamp(64px,9vw,120px)] sm:px-6">
            <h2 className="font-display text-[clamp(48px,8vw,128px)] font-bold leading-[0.9] tracking-[-0.05em]">
              Set your behest.
              <br />
              It will be <span className="inline-block rounded-full bg-mint px-[0.18em]">honoured</span>.
            </h2>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <ButtonLink href="/setup" className="min-h-[60px] px-8 text-[17px]">
                Create a plan (testnet)
              </ButtonLink>
              <InspectForm />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted sm:px-6">
          <span>Behest · open-source contracts · not a will, not legal advice</span>
          <nav aria-label="Footer" className="flex gap-4">
            <Link href="/inspect" className="hover:text-ink">Inspect a plan</Link>
            <Link href="/try" className="hover:text-ink">Try as…</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
