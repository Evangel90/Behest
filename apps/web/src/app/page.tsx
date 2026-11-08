import Link from "next/link";
import { Mark, SiteHeader, TestnetBar } from "@/components/chrome";
import { InspectForm } from "@/components/InspectForm";
import { FeatureExplorer, LandingDemo } from "@/components/LandingDemo";
import { ButtonLink } from "@/components/ui";

// Hairline-framed 1280px column used by every section.
const frame = "mx-auto max-w-[1280px] border-x border-hairline";
const frameDark = "mx-auto max-w-[1280px] border-x border-white/[0.11]";
const air = "pt-[clamp(96px,10vw,128px)]";
const h2 = "text-[clamp(30px,3.4vw,40px)] font-medium leading-none tracking-[-0.025em]";
const lede = "text-lg leading-7";

const SAFETY = [
  { t: "You keep control", b: "Funds sit in plan escrow and in vault addresses only your plan's contract can sign for. Behest never holds keys.", icon: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4" },
  { t: "Rules are public", b: "Anyone can read a plan's rules in plain words and in code, before and after a release.", icon: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
  { t: "Failures are visible", b: "If a transfer fails you see why, that the funds are safe, and who can retry. A retry never pays twice.", icon: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" },
  { t: "Not a will", b: "Behest follows your instructions. Pair it with legal estate planning that refers to it.", icon: "M7 3h7l4 4v14H7zM14 3v4h4M10 13h5M10 17h5" },
];

const TECH = [
  { t: "NEAR Protocol", c: "#2F6BFF", b: "Where your plan's rules live and are enforced: check-ins, guardians, waiting periods, every amount." },
  { t: "Chain Signatures", c: "#FB7A1E", b: "Lets the plan control its own Ethereum and Bitcoin addresses. The contract builds each transaction, so the MPC network can only sign what your plan allows." },
  { t: "Sponsored gas", c: "#3B82F6", b: "Meta-transactions so check-ins, approvals and claims need no NEAR. Network fees on other chains come from the plan." },
  { t: "Replaceable executors", c: "#A78BFA", b: "Signed transactions are public. Anyone can broadcast them; the contract records what landed." },
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
  ["Propose and approve a release", "nynnn"],
  ["Receive after the waiting period", "nnynn"],
  ["Broadcast a signed transfer", "nnyyn"],
  ["Pay NEAR gas for others", "nnnny"],
  ["Change where funds go", "nnnnn"],
];

const LIMITS = [
  { t: "Not a will", b: "Pair it with legal estate planning that refers to it." },
  { t: "Doesn't determine death", b: "It only knows check-ins stopped. Guardians decide whether to propose." },
  { t: "Public by default", b: "Rules and heir addresses are on-chain. A private mode is planned." },
  { t: "Testnet today", b: "Unaudited. NEAR, Sepolia ETH and WETH, wNEAR and Bitcoin testnet4 only." },
];

const FAQ = [
  { q: "What is Behest?", a: "A non-custodial way to pass on crypto. You set heirs, guardians and timing; a public contract on NEAR carries it out across NEAR, Ethereum and Bitcoin." },
  { q: "What if I forget to check in?", a: "Nothing can start until you're overdue and the grace period has passed. Even after guardians propose, you can cancel or check in until the waiting period ends." },
  { q: "Could guardians team up and take the funds?", a: "No. They can only approve releasing the plan exactly as written, to your heirs' fixed addresses." },
  { q: "Do heirs need crypto experience?", a: "They need the wallet address you recorded. Heir pages are in plain language, network fees come from the plan, and Behest pays their NEAR gas. In automatic mode they don't even need to claim." },
  { q: "What if Behest disappears?", a: "Rules live on-chain and executors are replaceable: every signed transfer is public and anyone can broadcast it." },
  { q: "What does it cost?", a: "On testnet nothing real. Network fees come out of the plan's own balance and are shown before anything is signed." },
];

export default function Landing() {
  return (
    <div className="bg-paper text-ink">
      <TestnetBar />
      <SiteHeader links={[["#features", "How it works"], ["#safety", "Safety"], ["#faq", "FAQ"], ["/inspect", "Inspect"]]} />

      <main>
        <section>
          <div className={frame}>
            <div className="flex flex-col items-start gap-6 px-4 pb-16 pt-[clamp(64px,8vw,96px)] sm:px-8">
              <h1 className="max-w-[900px] text-[clamp(36px,5vw,60px)] font-medium leading-none tracking-[-0.025em]">
                Everything you own,
                <br />
                passed on exactly as you wish.
              </h1>
              <p className={`max-w-[640px] text-muted ${lede}`}>
                Bitcoin, Ethereum and NEAR in one plan. Choose who receives what, check in now and then, and stay in control until the very last moment.
              </p>
              <div className="flex flex-wrap items-center gap-5">
                <ButtonLink href="/setup" variant="ink">
                  Create a plan
                </ButtonLink>
                <ButtonLink href="/try" variant="subtle">
                  Try it as a guardian or heir
                </ButtonLink>
              </div>
              <span className="text-base text-muted">No custody. No middlemen. Ready in minutes on testnet.</span>
            </div>
            <figure className="flex flex-col px-2 pb-24 sm:px-8">
              <figcaption className="flex items-center justify-center gap-2 px-4 pb-6 pt-2 text-base text-muted">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-signal/25" aria-hidden="true">
                  <span className="h-2 w-2 rounded-full bg-signal" />
                </span>
                Example plan. Explore the tabs, then check in.
              </figcaption>
              <LandingDemo />
            </figure>
          </div>
        </section>

        <section id="features" className="border-t border-hairline">
          <div className={`${frame} ${air}`}>
            <header className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={`${h2} max-w-[820px]`}>Your crypto deserves better than a seed phrase in a drawer.</h2>
              <p className={`max-w-[760px] text-muted ${lede}`}>Set it up once. Behest quietly keeps watch, and only acts the way you told it to.</p>
            </header>
            <FeatureExplorer />
          </div>
        </section>

        <section id="safety" className="bg-frame text-white">
          <div className={`${frameDark} ${air}`}>
            <header className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={h2}>Nobody can redirect a single coin.</h2>
              <p className={`max-w-[768px] text-[#A1A1A1] ${lede}`}>
                Not your guardians, not the people who send transactions, not us. The destinations you set are the only ones the contract will ever sign for.
              </p>
            </header>
            <div className="grid gap-px bg-white/[0.11] py-px sm:grid-cols-2 lg:grid-cols-4">
              {SAFETY.map((s) => (
                <div key={s.t} className="flex flex-col gap-16 bg-frame p-8">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(47,107,255,.16)]">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8DB4FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={s.icon} />
                    </svg>
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-lg font-medium tracking-[-0.015em]">{s.t}</h3>
                    <p className="text-sm leading-5 text-[#A1A1A1]">{s.b}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="h-[clamp(96px,10vw,128px)]" />
          </div>
        </section>

        <section className="border-t border-white/[0.11] bg-frame text-white">
          <div className={`${frameDark} ${air}`}>
            <header className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={h2}>Built on open infrastructure.</h2>
              <p className={`max-w-[768px] text-[#A1A1A1] ${lede}`}>Behest runs on NEAR technology that controls assets across chains without bridges or custodians.</p>
            </header>
            <div className="grid gap-px bg-white/[0.11] py-px sm:grid-cols-2 lg:grid-cols-4">
              {TECH.map((t) => (
                <div key={t.t} className="flex min-h-[240px] flex-col justify-between gap-16 bg-frame p-8">
                  <span className="h-2 w-2 rounded-full" style={{ background: t.c }} aria-hidden="true" />
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-lg font-medium tracking-[-0.015em]">{t.t}</h3>
                    <p className="text-sm leading-5 text-[#A1A1A1]">{t.b}</p>
                  </div>
                </div>
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
            <header className="flex flex-col gap-4 px-4 pb-16 sm:px-8">
              <h2 className={h2}>Everyone has a job. Nobody can redirect.</h2>
              <p className={`max-w-[760px] text-muted ${lede}`}>Only the owner sets destinations, and only while no release is open.</p>
            </header>
            <div className="px-4 pb-16 sm:px-8">
              <div className="overflow-x-auto rounded-row border border-line bg-card">
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

        <section id="faq" className="border-t border-hairline">
          <div className={frame}>
            <header className="flex flex-col items-start gap-4 border-b border-hairline px-4 pb-16 pt-[clamp(96px,10vw,128px)] sm:px-8">
              <h2 className={h2}>Frequently asked questions</h2>
              <p className={`text-muted ${lede}`}>Want to see a real plan? Look one up by its owner&apos;s account.</p>
              <InspectForm />
            </header>
            {FAQ.map((f) => (
              <details key={f.q} className="group border-b border-hairline">
                <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-4 px-4 py-6 text-lg tracking-[-0.015em] sm:px-8">
                  {f.q}
                  <span className="text-[22px] leading-7 text-muted transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p className="max-w-[760px] px-4 pb-6 text-base leading-6 text-muted sm:px-8">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="bg-gradient-to-b from-[#A9CCFF] via-[#6E9BFF] to-[#2F6BFF]">
          <div className="mx-auto flex max-w-[1280px] flex-col items-start gap-4 border-x border-black/[0.11] px-4 py-[clamp(96px,10vw,128px)] sm:px-8">
            <h2 className={`${h2} text-black`}>Your plan is minutes away.</h2>
            <p className={`text-black/70 ${lede}`}>Sign in with a NEAR or Ethereum wallet, add your heirs, and you&apos;re set.</p>
            <ButtonLink href="/setup" className="mt-2 bg-[#171717] text-white hover:bg-black">
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
