"use client";
// For the owner: the people they named by email, and whether each has been
// written to. Emails never go on-chain, so this card is the only place the
// owner sees them again; it reads this browser's copy and asks the notifier
// (one signature) only when the owner wants it refreshed.
import { Mail, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { humanError } from "@/lib/hooks";
import { listPeople, localPeople, peopleError, type Person } from "@/lib/people";
import { when } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { PlanView } from "@/lib/types";
import { Button, Card, Chip, SectionTitle } from "./ui";

const ROLE: Record<Person["role"], string> = { heir: "Heir", guardian: "Guardian", standby: "Standby guardian", delay: "Delay signer", recipient: "Recipient" };

function status(p: Person, inPlan: boolean): { label: string; tone: "active" | "waiting" | "failed" } {
  if (p.email_status === "unsubscribed") return { label: "Asked for no emails", tone: "failed" };
  if (!inPlan) return { label: "Not in the saved plan", tone: "waiting" };
  if (p.told_ms && (p.role !== "heir" || p.announce)) return { label: `Told ${when(p.told_ms)}`, tone: "active" };
  if (p.role === "heir" && !p.announce) return { label: "Hears at release", tone: "waiting" };
  return { label: "Being told", tone: "waiting" };
}

export function NamedPeopleCard({ view }: { view: PlanView }) {
  const { session } = useSession();
  const owner = view.plan.owner;
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPeople(localPeople(owner)), [owner, view.plan.version]);
  if (!session || session.accountId !== owner || people.length === 0) return null;
  const pol = view.plan.policy;
  const inPlan = (p: Person) => (p.role === "heir" ? pol.heirs.some((h) => h.account_id === p.account) : p.role === "guardian" ? pol.guardians.includes(p.account) : true);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setPeople((await listPeople(session)).people);
    } catch (e) {
      setError(peopleError(e) || humanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle
        icon={Mail}
        title="People you named by email"
        sub="Kept privately by Behest's notification service, never on the blockchain. Each signs in with their address or is written to there."
        aside={
          <Button variant="subtle" size="sm" icon={RefreshCw} loading={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      <ul className="flex flex-col divide-y divide-line">
        {people.map((p) => {
          const st = status(p, inPlan(p));
          return (
            <li key={`${p.account}:${p.role}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[15px] font-semibold">{p.label || p.email}</span>
                <span className="truncate text-[13px] text-muted">
                  {ROLE[p.role]} · {p.label ? `${p.email} · ` : ""}
                  {p.by_email ? "signs in with this email" : "notices only"}
                </span>
              </span>
              <Chip style={{ tone: st.tone, shape: st.tone === "active" ? "circle" : "square", label: st.label }}>{st.label}</Chip>
            </li>
          );
        })}
      </ul>
      {error && <p className="text-sm text-error">{error}</p>}
    </Card>
  );
}
