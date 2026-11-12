import Link from "next/link";
import { Mark, SiteHeader, TestnetBar } from "@/components/chrome";
import { InspectForm } from "@/components/InspectForm";
import { Pricing } from "@/components/Tiers";
import { FeatureExplorer, LandingDemo } from "@/components/LandingDemo";
import { ArrowRight, Eye, FlaskConical, Hourglass, Lock, Plus, RotateCcw } from "lucide-react";
import { Reveal } from "@/components/motion";
import { ButtonLink } from "@/components/ui";

// Hairline-framed 1280px column used by every section.
const frame = "mx-auto max-w-[1280px] border-x border-hairline";
const frameDark = "mx-auto max-w-[1280px] border-x border-white/[0.11]";
const air = "pt-[clamp(96px,10vw,128px)]";
const h2 = "text-[clamp(30px,3.4vw,40px)] font-medium leading-none tracking-[-0.025em]";
const lede = "text-lg leading-7";

const SAFETY = [
  { t: "You keep control", b: "Funds sit in plan escrow and in vault addresses only your plan's contract can sign for. Behest never holds keys.", icon: Lock },
  { t: "Rules are public", b: "Anyone can read a plan's rules in plain words and in code. Heirs can be kept private until they're needed; everything else stays checkable.", icon: Eye },
  { t: "Edits give notice", b: "Changes to heirs, addresses and guardians can wait a notice period, and everyone on the plan is told. A stolen key can't quietly rewrite your plan.", icon: Hourglass },
  { t: "Failures are visible", b: "If a transfer fails you see why, that the funds are safe, and who can retry. A retry never pays twice.", icon: RotateCcw },
];

const TECH = [
  { t: "NEAR Protocol", c: "#2F6BFF", b: "Where your plan's rules live and are enforced: check-ins, guardians, waiting periods, every amount." },
  { t: "Chain Signatures", c: "#FB7A1E", b: "Lets the plan control its own Ethereum and Bitcoin addresses. The contract builds each transaction, so the MPC network can only sign what your plan allows." },
  { t: "NEAR Intents", c: "#22C55E", b: "Heirs can receive into their Intents account and swap to almost any asset. On mainnet, plan fees can be paid with almost any asset too." },
  { t: "Any wallet, no gas", c: "#3B82F6", b: "Sign in with a NEAR wallet, MetaMask or another Ethereum wallet. Behest pays NEAR gas and plan storage; executors that broadcast signed transfers are replaceable." },
];

const STATS = [
  { v: "3", l: "chains on testnet" },
  { v: "0", l: "custodians" },
  { v: "1 tap", l: "to check in" },
  { v: "100%", l: "of rules on-chain" },
];

const COLS = ["Owner", "Guardians", "Heirs", "Executors", "Gas relayer"];
const ROWS: [string, string][] = [
  ["Set heirs, amounts, destinations", "ynnnn"],
  ["Check in, or cancel before the cutoff", "ynnnn"],
  ["Approve a heir's new address", "ynnnn"],
  ["Propose and approve a release", "nynnn"],
  ["Prove an address, or ask for a new one", "nnynn"],
  ["Reveal a private heir once the owner is overdue", "nnynn"],
  ["Receive after the waiting period", "nnynn"],
  ["Broadcast a signed transfer", "nnyyn"],
  ["Pay NEAR gas for others", "nnnny"],
  ["Change where funds go once a release is open", "nnnnn"],
];

const LIMITS = [
  { t: "Not a will", b: "Pair it with legal estate planning that refers to it." },
  { t: "Doesn't determine death", b: "It only knows check-ins stopped. Guardians decide whether to propose." },
  { t: "Private, not secret forever", b: "Private heirs stay hidden until you're overdue. Once revealed, and once paid, they're on the public record." },
  { t: "Testnet today", b: "Unaudited. NEAR, Sepolia ETH and WETH, wNEAR and Bitcoin testnet4. NEAR Intents payments are mainnet only." },
];

const FAQ = [
  { q: "What is Behest?", a: "A non-custodial way to pass on crypto. You set heirs, guardians and timing; a public contract on NEAR carries it out across NEAR, Ethereum and Bitcoin." },
  { q: "What if I forget to check in?", a: "Nothing can start until you're overdue and the grace period has passed. Even after guardians propose, you can cancel or check in until the waiting period ends." },
  { q: "Could guardians team up and take the funds?", a: "No. They can only approve releasing the plan exactly as written, to your heirs' fixed addresses." },
  {
    q: "Can I keep my heirs private?",
    a: "Yes. Choose Private when you set up the plan. The chain then holds only a fingerprint per heir, so nobody can read who inherits, how much or where. Each heir gets a recovery record (it's in their printed packet, with a QR code). Once you've stopped checking in, they reveal it; if you check in again, the plan is hidden again. You decide whether Behest keeps an encrypted copy of the records, which it hands each heir only once you're overdue. A share nobody reveals in time goes to the other heirs or to your fallback. Standard tier.",
  },
  {
    q: "What if a guardian disappears?",
    a: "Turn on availability checks and guardians confirm now and then that they're still around. Name standbys, and one can take a quiet guardian's seat after a delay you set. Guardians can also hand their seat to a new account or step down. The number of approvals needed never goes down on its own.",
  },
  {
    q: "What if someone gets my key?",
    a: "Set an edit notice. Changes to heirs, addresses, shares and guardians then wait that long before they take effect, everyone on the plan is told, and you can cancel. Add a second key to your account or a check-in delegate as a way back in.",
  },
  {
    q: "How do I know my heirs' addresses are right?",
    a: "Heirs prove they control each address: a NEAR account by signing in, an Ethereum address with a signature, a Bitcoin address with a signed message. Your plan shows which are proven. While you're around, a heir can ask you to change an address; only you can approve it.",
  },
  { q: "Do heirs need crypto experience?", a: "They need the wallet address you recorded. Heir pages are in plain language, network fees come from the plan, and Behest pays their NEAR gas. In automatic mode they don't even need to claim." },
  { q: "What if Behest disappears?", a: "Rules live on-chain and executors are replaceable: every signed transfer is public and anyone can broadcast it. Each heir's printed recovery packet explains how to claim with any NEAR tool, without Behest's website." },
  { q: "Can a DAO or a company use it?", a: "Yes. A Sputnik DAO can own a plan, be a guardian or be a heir; its members vote on each action. Owners can also name check-in delegates." },
  { q: "How will I know when something happens?", a: "Turn on notifications by email, Telegram or webhook. Owners get check-in reminders; guardians and heirs hear when a release is proposed, approved or ready, when a private heir is revealed, and when the plan changes." },
  {
    q: "What does it cost?",
    a: "A plan with one heir and NEAR is free. More heirs, Ethereum and Bitcoin, NEAR Intents delivery, private heirs, release rules and check-in delegates are Standard; automatic release and delay signers are Complete. Each is a one-time USDC fee that anyone can pay for you, and upgrading costs only the difference. Behest pays plan storage and NEAR gas. Ethereum and Bitcoin network fees come out of the plan's own vault and are shown before anything is signed. On testnet, payments use free test USDC.",
  },
];

export default function Landing() {
  return (
    <div className="bg-paper text-ink">
      <TestnetBar />
      <SiteHeader links={[["#features", "How it works"], ["#safety", "Safety"], ["#pricing", "Pricing"], ["#faq", "FAQ"], ["/inspect", "Inspect"]]} />

      <a href="#main" className="sr-only z-50 rounded-tile bg-ink px-4 py-3 text-ink-contrast focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      <main id="main">
        <section>
          <div className={frame}>
            <div className="flex animate-fade-up flex-col items-start gap-6 px-4 pb-16 pt-[clamp(64px,8vw,96px)] sm:px-8">
              <h1 className="max-w-[900px] text-[clamp(36px,5vw,60px)] font-medium leading-none tracking-[-0.025em]">
                Everything you own,
                <br />
                passed on exactly as you wish.
              </h1>
              <p className={`max-w-[640px] text-muted ${lede}`}>
                Bitcoin, Ethereum and NEAR in one plan. Choose who receives what, publicly or privately, check in now and then, and stay in control until the very last moment.
              </p>
              <div className="flex flex-wrap items-center gap-5">
                <ButtonLink href="/setup" variant="ink" size="lg" iconRight={ArrowRight}>
                  Create a plan
                </ButtonLink>
                <ButtonLink href="/try" variant="subtle" size="lg" icon={FlaskConical}>
                  Try it as a guardian or heir
                </ButtonLink>
              </div>
              <span className="text-base text-muted">No custody. No middlemen. Ready in minutes on testnet.</span>
            </div>
            <figure className="flex flex-col px-2 pb-24 sm:px-8">
              <figcaption className="flex items-center justify-center gap-2 px-4 pb-6 pt-2 text-base text-muted">
                <span className="flex h-4 w-4 animate-breathe items-center justify-center rounded-full bg-signal/25" aria-hidden="true">
                  <span className="h-2 w-2 rounded-full bg-signal" />
                </span>
                Example plan. Explore the tabs, then check in.
              </figcaption>
              <Reveal y={24}>
                <LandingDemo />
              </Reveal>
            </figure>
          </div>
        </section>

        <section id="features" className="border-t border-hairline">
          <div className={`${frame} ${air}`}>
            <Reveal className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={`${h2} max-w-[820px]`}>Your crypto deserves better than a seed phrase in a drawer.</h2>
              <p className={`max-w-[760px] text-muted ${lede}`}>Set it up once. Behest quietly keeps watch, and only acts the way you told it to.</p>
            </Reveal>
            <FeatureExplorer />
          </div>
        </section>

        <section id="safety" className="bg-frame text-white">
          <div className={`${frameDark} ${air}`}>
            <Reveal className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={h2}>Nobody can redirect a single coin.</h2>
              <p className={`max-w-[768px] text-[#A1A1A1] ${lede}`}>
                Not your guardians, not the people who send transactions, not us. The destinations you set are the only ones the contract will ever sign for.
              </p>
            </Reveal>
            <div className="grid gap-px bg-white/[0.11] py-px sm:grid-cols-2 lg:grid-cols-4">
              {SAFETY.map((s, i) => (
                <Reveal key={s.t} delay={i * 0.06} className="flex flex-col gap-16 bg-frame p-8">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(47,107,255,.16)]">
                    <s.icon aria-hidden className="size-5 text-[#8DB4FF]" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-lg font-medium tracking-[-0.015em]">{s.t}</h3>
                    <p className="text-sm leading-5 text-[#A1A1A1]">{s.b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <div className="h-[clamp(96px,10vw,128px)]" />
          </div>
        </section>

        <section className="border-t border-white/[0.11] bg-frame text-white">
          <div className={`${frameDark} ${air}`}>
            <Reveal className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={h2}>Built on open infrastructure.</h2>
              <p className={`max-w-[768px] text-[#A1A1A1] ${lede}`}>Behest runs on NEAR technology that controls assets across chains without bridges or custodians.</p>
            </Reveal>
            <div className="grid gap-px bg-white/[0.11] py-px sm:grid-cols-2 lg:grid-cols-4">
              {TECH.map((t, i) => (
                <Reveal key={t.t} delay={i * 0.06} className="flex min-h-[240px] flex-col justify-between gap-16 bg-frame p-8">
                  <span className="h-2 w-2 rounded-full" style={{ background: t.c }} aria-hidden="true" />
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-lg font-medium tracking-[-0.015em]">{t.t}</h3>
                    <p className="text-sm leading-5 text-[#A1A1A1]">{t.b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <div aria-label="Supported assets" className="flex flex-wrap items-center justify-between gap-8 px-4 py-12 text-xl font-semibold tracking-[-0.02em] text-[#A1A1A1] sm:px-8">
              <span>Bitcoin</span>
              <span>Ethereum</span>
              <span>NEAR</span>
              <span>NEP-141 tokens</span>
              <span>ERC-20 tokens</span>
            </div>
            <div className="grid gap-px bg-white/[0.11] pt-px sm:grid-cols-2 lg:grid-cols-4">
              {STATS.map((s) => (
                <div key={s.l} className="flex flex-col gap-1 bg-frame px-8 pb-8 pt-16">
                  <span className="text-[clamp(40px,4.4vw,60px)] leading-none tracking-[-0.035em]">{s.v}</span>
                  <span className="text-base text-[#A1A1A1]">{s.l}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className={`${frame} ${air}`}>
            <Reveal className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={h2}>Everyone has a job. Nobody can redirect.</h2>
              <p className={`max-w-[760px] text-muted ${lede}`}>Only the owner sets destinations, only while no release is open, and big edits can wait a notice period. A delegate or DAO can check in for the owner; a standby can take a quiet guardian&apos;s seat.</p>
            </Reveal>
            <div className="px-4 pb-16 sm:px-8">
              <ul className="flex flex-col gap-2 md:hidden">
                {ROWS.map(([a, cells]) => {
                  const who = cells.split("").flatMap((c, i) => (c === "y" ? [COLS[i]!] : []));
                  return (
                    <li key={a} className="flex flex-col gap-2 rounded-row border border-line bg-card p-4">
                      <span className="font-medium">{a}</span>
                      <span className="flex flex-wrap gap-1.5">
                        {who.length ? (
                          who.map((w) => (
                            <span key={w} className="inline-flex h-7 items-center rounded-tag bg-s-active px-2.5 text-sm font-semibold text-[var(--s-active-fg)]">
                              {w}
                            </span>
                          ))
                        ) : (
                          <span className="inline-flex h-7 items-center rounded-tag bg-subtle px-2.5 text-sm font-semibold text-muted">Nobody</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="hidden overflow-x-auto rounded-row border border-line bg-card md:block">
                <table className="w-full min-w-[720px] border-collapse text-left text-[15px]">
                  <thead>
                    <tr className="bg-subtle text-[13px] text-muted">
                      <th scope="col" className="px-5 py-3 font-medium">
                        Action
                      </th>
                      {COLS.map((c) => (
                        <th key={c} scope="col" className="px-3 py-3 text-center font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map(([a, cells]) => (
                      <tr key={a} className="border-t border-line">
                        <th scope="row" className="px-5 py-3.5 font-medium">
                          {a}
                        </th>
                        {cells.split("").map((c, i) => (
                          <td key={i} className="px-3 py-3 text-center">
                            {c === "y" ? (
                              <span className="inline-flex h-7 items-center rounded-tag bg-s-active px-2.5 text-sm font-semibold text-[var(--s-active-fg)]" aria-label={`${COLS[i]} can`}>
                                Yes
                              </span>
                            ) : (
                              <span className="text-muted" aria-label={`${COLS[i]} cannot`}>
                                —
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="grid gap-px border-t border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
              {LIMITS.map((l) => (
                <div key={l.t} className="flex flex-col gap-1 bg-paper p-8">
                  <h3 className="text-lg font-medium tracking-[-0.015em]">{l.t}</h3>
                  <p className="text-sm leading-5 text-muted">{l.b}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="border-t border-hairline">
          <div className={`${frame} ${air}`}>
            <Reveal className="flex flex-col gap-4 px-4 pb-10 sm:px-8">
              <h2 className={`${h2} max-w-[820px]`}>Pay once, for what your plan needs.</h2>
              <p className={`max-w-[760px] text-muted ${lede}`}>One heir and NEAR cost nothing. Add more when you need it.</p>
            </Reveal>
            <div className="px-4 sm:px-8">
              <Pricing />
            </div>
          </div>
        </section>

        <section id="faq" className="border-t border-hairline">
          <div className={frame}>
            <header className="flex flex-col items-start gap-4 border-b border-hairline px-4 pb-16 pt-[clamp(96px,10vw,128px)] sm:px-8">
              <h2 className={h2}>Frequently asked questions</h2>
              <p className={`text-muted ${lede}`}>Want to see a real plan? Look one up by its owner&apos;s account.</p>
              <InspectForm recent />
            </header>
            {FAQ.map((f) => (
              <details key={f.q} className="faq group border-b border-hairline">
                <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-4 px-4 py-6 text-lg tracking-[-0.015em] transition-colors hover:text-signal-text sm:px-8 [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <Plus aria-hidden className="mt-1 size-5 shrink-0 text-muted transition-transform duration-300 ease-ledger group-open:rotate-45" />
                </summary>
                <p className="max-w-[760px] px-4 pb-6 text-base leading-6 text-muted sm:px-8">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="bg-gradient-to-b from-[#A9CCFF] via-[#6E9BFF] to-[#2F6BFF]">
          <div className="mx-auto flex max-w-[1280px] flex-col items-start gap-4 border-x border-black/[0.11] px-4 py-[clamp(96px,10vw,128px)] sm:px-8">
            <h2 className={`${h2} text-black`}>Your plan is minutes away.</h2>
            <p className={`text-black/70 ${lede}`}>Sign in with a NEAR or Ethereum wallet, pick a preset, add your heirs, and you&apos;re set.</p>
            <ButtonLink href="/setup" size="lg" iconRight={ArrowRight} variant="night" className="mt-2">
              Create a plan
            </ButtonLink>
          </div>
        </section>
      </main>

      <footer className="overflow-hidden bg-frame text-white">
        <div className={frameDark}>
          <div className="grid gap-16 px-4 py-24 sm:px-8 md:grid-cols-2">
            <div className="flex flex-col gap-5">
              <span className="flex items-center gap-2.5">
                <Mark light />
                <span className="text-[21px] font-semibold tracking-[-0.03em]">behest</span>
              </span>
              <p className="max-w-[400px] text-base leading-6 text-[#A1A1A1]">Non-custodial inheritance for Bitcoin, Ethereum and NEAR. Not a will or legal advice. Testnet software.</p>
            </div>
            <div className="grid grid-cols-2 gap-8">
              {[
                { h: "Product", links: [["/app", "Dashboard"], ["/setup", "Create a plan"], ["/inspect", "Inspect a plan"]] as const },
                { h: "Try it", links: [["/try", "Try as a guardian or heir"], ["#faq", "FAQ"]] as const },
              ].map((c) => (
                <div key={c.h} className="flex flex-col gap-6">
                  <h3 className="text-base font-medium">{c.h}</h3>
                  <ul className="flex flex-col gap-4">
                    {c.links.map(([href, l]) => (
                      <li key={href}>
                        <Link href={href} className="text-base text-[#A1A1A1] hover:text-white">
                          {l}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden="true" className="h-[clamp(90px,15vw,210px)] overflow-hidden px-4 sm:px-8">
            <span className="block text-[clamp(150px,26vw,360px)] font-semibold leading-[0.82] tracking-[-0.06em] text-[#333333]">behest</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
