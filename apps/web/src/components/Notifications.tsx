"use client";
// Notification settings: where Behest reaches the signed-in account (email,
// Telegram, webhooks), which notices it sends, and which plans it watches.
// Contacts are kept by the notifier service, never on-chain; each change is
// signed by the account (a message, not a transaction).
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BellRing, Eye, History, KeyRound, ListChecks, Mail, Plus, RefreshCw, Send, Trash2, UserRound, Users, Webhook, WifiOff, type LucideIcon } from "lucide-react";
import { getPlan, listOpenReleases } from "@/lib/contract";
import { watched } from "@/lib/demo";
import {
  addEmail,
  addWebhook,
  forgetSession,
  getInfo,
  getSettings,
  hasSession,
  linkTelegram,
  NotifierError,
  openSession,
  removeContact,
  resendConfirmation,
  saveWatches,
  setCouncil,
  savePreferences,
  testContact,
  type Contact,
  type NotifierInfo,
  type Settings,
} from "@/lib/notify";
import { rolesOf, shortName, when } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { ChipStyle } from "@/lib/plan";
import { useConfirm, useToast } from "./feedback";
import { CopyButton, Field } from "./interactive";
import { Stagger, StaggerItem } from "./motion";
import { Avatar } from "./PlanParts";
import { SignInDialog } from "./SignIn";
import { Button, ButtonLink, Card, Chip, EmptyState, Notice, SectionTitle, Skeleton, cx, inputClass } from "./ui";

const errText = (e: unknown) => (e instanceof NotifierError || e instanceof Error ? e.message : String(e));

const STATUS: Record<Contact["status"], ChipStyle> = {
  active: { label: "On", tone: "approved", shape: "circle" },
  pending: { label: "Waiting for confirmation", tone: "waiting", shape: "diamond" },
  disabled: { label: "Off", tone: "failed", shape: "square" },
};

const CHANNEL_ICON: Record<Contact["channel"], LucideIcon> = { email: Mail, telegram: Send, webhook: Webhook };

function StatusChip({ c }: { c: Contact }) {
  const s = STATUS[c.status];
  return <Chip style={s}>{s.label}</Chip>;
}

function NotifySkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading notification settings">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="flex flex-col gap-3">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-12 w-full rounded-tile" />
        </Card>
      ))}
    </div>
  );
}

export function Notifications() {
  const { session: acting, ready } = useSession();
  // D26: a DAO can't sign in to the notifier; its council member does, for themselves and for the DAO.
  const session = acting?.dao?.member ?? acting;
  const dao = acting?.dao?.id ?? null;
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState<NotifierInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: number; secret: string } | null>(null);
  const [signIn, setSignIn] = useState(false);

  const loadInfo = useCallback(() => {
    setInfoError(null);
    getInfo().then(setInfo, (e) => setInfoError(errText(e)));
  }, []);
  useEffect(() => loadInfo(), [loadInfo]);

  const load = useCallback(
    async (t: string) => {
      try {
        setSettings(await getSettings(t));
      } catch (e) {
        if (e instanceof NotifierError && e.code === "NO_SESSION" && session) {
          forgetSession(session.accountId);
          setToken(null);
        } else toast.show({ tone: "error", title: "Couldn't load your settings", body: errText(e) });
      }
    },
    [session, toast],
  );

  const connect = useCallback(async () => {
    if (!session) return;
    setBusy("connect");
    setConnectError(null);
    try {
      const t = await openSession(session);
      setToken(t);
      await load(t);
    } catch (e) {
      setConnectError(errText(e));
    } finally {
      setBusy(null);
    }
  }, [session, load]);

  // Personas sign silently, and a token from earlier in this tab is reused; wallets wait for a click.
  useEffect(() => {
    setToken(null);
    setSettings(null);
    setSecret(null);
    if (session && info && (session.kind === "persona" || hasSession(session.accountId))) void connect();
  }, [session, info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    try {
      const text = await fn();
      if (text) toast.show({ tone: "ok", title: text });
      if (token) await load(token);
    } catch (e) {
      toast.show({ tone: "error", title: "That didn't work", body: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const remove = async (c: Contact, verb = "Remove") => {
    if (await confirm({ title: `${verb} ${c.channel === "telegram" ? "this Telegram chat" : c.address}?`, body: "Notices stop going there straight away. You can add it again later.", confirmLabel: verb, tone: "danger" }))
      await act(`remove-${c.id}`, async () => (await removeContact(session!, c), verb === "Unlink" ? "Unlinked." : "Removed."));
  };

  if (!ready) return <NotifySkeleton />;
  if (!session) {
    return (
      <>
        <EmptyState icon={UserRound} title="Sign in to set up notifications" body="Owners get check-in reminders; guardians and heirs hear when a release moves. Sign in with the account the plan names.">
          <Button variant="primary" onClick={() => setSignIn(true)}>
            Sign in
          </Button>
        </EmptyState>
        <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
      </>
    );
  }
  if (infoError)
    return (
      <EmptyState icon={WifiOff} tone="error" title="The notification service isn't reachable" body={`${infoError.replace(/\.$/, "")}. Plans keep working without it: notifications never change what the contract does.`}>
        <Button variant="ink" icon={RefreshCw} onClick={loadInfo}>
          Try again
        </Button>
      </EmptyState>
    );
  if (!info) return <NotifySkeleton />;

  if (!token || !settings) {
    if (session.kind === "persona" && busy === "connect") return <NotifySkeleton />;
    return (
      <Card className="flex flex-col gap-4">
        <SectionTitle icon={KeyRound} title={`Notifications for ${session.kind === "persona" ? session.label : session.accountId}`} />
        <p className="text-[15px] leading-relaxed text-muted">To see or change where Behest reaches you, sign a short message with this account. It proves the account is yours; it isn&apos;t a transaction and costs nothing.</p>
        {connectError && <Notice tone="error">{connectError}</Notice>}
        <Button variant="primary" icon={KeyRound} className="self-start" onClick={() => void connect()} loading={busy === "connect"}>
          {busy === "connect" ? "Waiting for signature…" : "Sign and continue"}
        </Button>
      </Card>
    );
  }

  const byChannel = (ch: Contact["channel"]) => settings.contacts.filter((c) => c.channel === ch);
  const active = settings.contacts.filter((c) => c.status === "active").length;
  return (
    <div className="flex flex-col gap-6">
      <Notice tone={active ? "ok" : "info"} title={active ? `Reaching you in ${active} place${active === 1 ? "" : "s"}` : "No confirmed contacts yet"}>
        Your contacts are kept by Behest&apos;s notification service, not on the blockchain, and only you can see them. If a notice fails to arrive, nothing about your plan changes.
      </Notice>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <EmailCard
          info={info}
          contacts={byChannel("email")}
          busy={busy}
          onAdd={(a) => act("email", async () => (await addEmail(session, a)).message)}
          onResend={(c) => act(`resend-${c.id}`, async () => (await resendConfirmation(token, c.id), `A new confirmation link is on its way to ${c.address}.`))}
          onRemove={(c) => remove(c)}
          onTest={(c) => act(`test-${c.id}`, () => runTest(token, c))}
        />
        <TelegramCard
          info={info}
          contacts={byChannel("telegram")}
          busy={busy}
          onLink={() =>
            act("telegram", async () => {
              const { url } = await linkTelegram(session);
              window.open(url, "_blank", "noopener");
              return "Telegram opened. Press Start in the chat with the Behest bot, then come back here (the link works once, for 15 minutes).";
            })
          }
          onRemove={(c) => remove(c, "Unlink")}
          onTest={(c) => act(`test-${c.id}`, () => runTest(token, c))}
          onRefresh={() => act("refresh", async () => {})}
        />
      </div>

      <WebhookCard
        info={info}
        contacts={byChannel("webhook")}
        busy={busy}
        secret={secret}
        onAdd={(url, label) =>
          act("webhook", async () => {
            const r = await addWebhook(session, url, label);
            setSecret({ id: r.contact.id, secret: r.secret });
            return r.message;
          })
        }
        onRemove={(c) => remove(c)}
        onTest={(c) => act(`test-${c.id}`, () => runTest(token, c))}
      />

      <WatchCard
        account={session.accountId}
        watches={settings.watches}
        max={info.limits.watches}
        busy={busy}
        onSave={(owners) =>
          act("watches", async () => {
            const r = await saveWatches(session, owners);
            return r.refused.length ? `Saved. Not added (this account has no role in them): ${r.refused.join(", ")}.` : "Saved.";
          })
        }
      />

      {dao && (
        <CouncilCard
          dao={dao}
          on={(settings.councils ?? []).includes(dao)}
          busy={busy}
          onSave={(enabled) =>
            act("council", async () => {
              const r = await setCouncil(session, dao, enabled);
              return enabled ? `Every ${dao} council member (${r.members.length}) now gets the DAO's notices on their own contacts.` : `${dao}'s notices no longer go to its council.`;
            })
          }
        />
      )}

      <PrefsCard info={info} prefs={settings.preferences} busy={busy} onSave={(p) => act("prefs", async () => (await savePreferences(session, p), "Saved."))} />

      <Card className="flex flex-col gap-4">
        <SectionTitle icon={History} title="Recent notices" sub={settings.recent.length ? `${settings.recent.length} most recent` : undefined} />
        {settings.recent.length === 0 ? (
          <p className="text-[15px] text-muted">Nothing yet. Notices you receive appear here.</p>
        ) : (
          <Stagger as="ol" className="flex flex-col">
            {settings.recent.map((n) => (
              <StaggerItem as="li" key={n.key} className="flex gap-3 border-t border-line py-3 first:border-0 first:pt-0 last:pb-0">
                <span aria-hidden className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle">
                  <BellRing className="size-4 text-muted" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-semibold">{n.subject}</span>
                  <span className="text-sm leading-relaxed">{n.text}</span>
                  <span className="text-xs text-muted">{when(n.created_ms)}</span>
                </span>
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </Card>
    </div>
  );
}

async function runTest(token: string, c: Contact) {
  const r = await testContact(token, c.id);
  if (!r.ok) throw new Error(`The test didn't arrive: ${r.error ?? "unknown error"}`);
  return "Test sent.";
}

function ContactRow({ c, busy, onRemove, onTest, children }: { c: Contact; busy: string | null; onRemove: (c: Contact) => void; onTest?: (c: Contact) => void; children?: ReactNode }) {
  const I = CHANNEL_ICON[c.channel];
  return (
    <li className="flex animate-fade-up flex-col gap-3 rounded-row border border-line p-3.5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-subtle">
          <I className="size-4 text-muted" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="min-w-0 break-all font-mono text-sm">
            {c.label && c.channel !== "email" ? `${c.label} · ` : ""}
            {c.channel === "telegram" ? `chat ${c.address}` : c.address}
          </span>
          {c.disabled_reason && <span className="text-[13px] text-error">Turned off: {c.disabled_reason}</span>}
          {c.last_delivery && (
            <span className="text-[13px] text-muted">
              Last notice: {c.last_delivery.status}
              {c.last_delivery.error ? ` (${c.last_delivery.error})` : ""} · {when(c.last_delivery.at_ms)}
            </span>
          )}
        </span>
        <StatusChip c={c} />
      </div>
      {children}
      <div className="flex flex-wrap gap-2">
        {onTest && c.status === "active" && (
          <Button variant="outline" size="sm" icon={Send} onClick={() => onTest(c)} disabled={!!busy && busy !== `test-${c.id}`} loading={busy === `test-${c.id}`}>
            Send a test
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={Trash2} onClick={() => onRemove(c)} disabled={!!busy && busy !== `remove-${c.id}`} loading={busy === `remove-${c.id}`} className="text-error">
          Remove
        </Button>
      </div>
    </li>
  );
}

function ChannelCard({ icon, title, sub, children }: { icon: LucideIcon; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={icon} title={title} sub={sub} />
      {children}
    </Card>
  );
}

function EmailCard({ info, contacts, busy, onAdd, onResend, onRemove, onTest }: { info: NotifierInfo; contacts: Contact[]; busy: string | null; onAdd: (a: string) => void; onResend: (c: Contact) => void; onRemove: (c: Contact) => void; onTest: (c: Contact) => void }) {
  const [address, setAddress] = useState("");
  const [tried, setTried] = useState(false);
  const bad = !!address.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (address.trim() && !bad) {
      onAdd(address.trim());
      setAddress("");
      setTried(false);
    }
  };
  return (
    <ChannelCard icon={Mail} title="Email" sub="Confirmed with a link before anything else is sent.">
      {!info.channels.email && <Notice>Email isn&apos;t set up on this Behest server yet.</Notice>}
      {contacts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {contacts.map((c) => (
            <ContactRow key={c.id} c={c} busy={busy} onRemove={onRemove} onTest={onTest}>
              {c.status !== "active" && (
                <Button variant="subtle" size="sm" icon={RefreshCw} className="self-start" onClick={() => onResend(c)} disabled={!!busy} loading={busy === `resend-${c.id}`}>
                  Send a new link
                </Button>
              )}
            </ContactRow>
          ))}
        </ul>
      )}
      {info.channels.email && contacts.length < info.limits.email && (
        <form onSubmit={submit} noValidate className="flex flex-col gap-2">
          <Field label="Add an email address" hint="We send a link first; nothing else arrives until you confirm it." error={tried && bad ? "That doesn't look like an email address." : null}>
            {(p) => (
              <div className="flex gap-2">
                <input {...p} className={inputClass} type="email" autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="you@example.com" />
                <Button type="submit" variant="ink" icon={Plus} disabled={!!busy || !address.trim()} loading={busy === "email"}>
                  Add
                </Button>
              </div>
            )}
          </Field>
        </form>
      )}
    </ChannelCard>
  );
}

function TelegramCard({ info, contacts, busy, onLink, onRemove, onTest, onRefresh }: { info: NotifierInfo; contacts: Contact[]; busy: string | null; onLink: () => void; onRemove: (c: Contact) => void; onTest: (c: Contact) => void; onRefresh: () => void }) {
  return (
    <ChannelCard icon={Send} title="Telegram" sub="Send /stop to the bot at any time to unlink.">
      {!info.channels.telegram && <Notice>Telegram isn&apos;t set up on this Behest server yet.</Notice>}
      {contacts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {contacts.map((c) => (
            <ContactRow key={c.id} c={c} busy={busy} onRemove={onRemove} onTest={onTest} />
          ))}
        </ul>
      )}
      {info.channels.telegram && (
        <div className="flex flex-wrap items-center gap-2">
          {contacts.length < info.limits.telegram && (
            <Button variant="ink" icon={Send} onClick={onLink} disabled={!!busy && busy !== "telegram"} loading={busy === "telegram"}>
              {busy === "telegram" ? "Waiting for signature…" : contacts.length ? "Link another chat" : "Link Telegram"}
            </Button>
          )}
          <Button variant="outline" icon={RefreshCw} onClick={onRefresh} disabled={!!busy} loading={busy === "refresh"}>
            I&apos;ve pressed Start
          </Button>
        </div>
      )}
    </ChannelCard>
  );
}

function WebhookCard({ info, contacts, busy, secret, onAdd, onRemove, onTest }: { info: NotifierInfo; contacts: Contact[]; busy: string | null; secret: { id: number; secret: string } | null; onAdd: (url: string, label?: string) => void; onRemove: (c: Contact) => void; onTest: (c: Contact) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [tried, setTried] = useState(false);
  const bad = !!url.trim() && !(info.webhook_https_only ? /^https:\/\/\S+$/ : /^https?:\/\/\S+$/).test(url.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (url.trim() && !bad) {
      onAdd(url.trim(), label.trim() || undefined);
      setUrl("");
      setLabel("");
      setTried(false);
    }
  };
  return (
    <ChannelCard
      icon={Webhook}
      title="Webhooks"
      sub={
        <>
          Behest POSTs signed JSON. Slack and Discord incoming webhooks work as they are{info.webhook_https_only ? "; https only" : ""}.
        </>
      }
    >
      <p className="rounded-tile bg-subtle p-3 font-mono text-xs leading-relaxed text-muted">X-Behest-Signature: v1=HMAC-SHA256(secret, timestamp + &quot;.&quot; + body)</p>
      {contacts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {contacts.map((c) => (
            <ContactRow key={c.id} c={c} busy={busy} onRemove={onRemove} onTest={onTest}>
              {secret?.id === c.id && (
                <div className="flex flex-col gap-2 rounded-tile border border-warn/40 bg-warn-bg p-3">
                  <span className="text-[13px] font-semibold">Signing secret: copy it now, it won&apos;t be shown again</span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-sm">{secret.secret}</code>
                    <CopyButton value={secret.secret} label="Copy secret" />
                  </div>
                </div>
              )}
            </ContactRow>
          ))}
        </ul>
      )}
      {contacts.length < info.limits.webhook && (
        <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-start">
          <Field label="Webhook URL" error={tried && bad ? (info.webhook_https_only ? "Use an https:// URL." : "Use an http(s):// URL.") : null}>
            {(p) => <input {...p} className={inputClass} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" spellCheck={false} autoCapitalize="none" />}
          </Field>
          <Field label="Name" optional>
            {(p) => <input {...p} className={inputClass} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Family Slack" />}
          </Field>
          <Button type="submit" variant="ink" icon={Plus} className="md:mt-[30px]" disabled={!!busy || !url.trim()} loading={busy === "webhook"}>
            Add webhook
          </Button>
        </form>
      )}
    </ChannelCard>
  );
}

/** Plans that involve this account, so guardians and heirs hear about them before a release opens. */
/** D26: send a DAO's plan notices to every council member's own contacts. */
function CouncilCard({ dao, on, busy, onSave }: { dao: string; on: boolean; busy: string | null; onSave: (enabled: boolean) => void }) {
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={Users} title={`Notify all of ${dao}'s council`} sub="A DAO has no inbox. Switch this on and every notice for the DAO (reminders, releases, votes, payouts) also goes to each current council member, on the contacts they set up here. People who leave the council stop getting them." />
      <Button variant={on ? "outline" : "primary"} className="self-start" disabled={!!busy && busy !== "council"} loading={busy === "council"} onClick={() => onSave(!on)}>
        {busy === "council" ? "Waiting for signature…" : on ? "Stop notifying the council" : "Subscribe all council members"}
      </Button>
      <p className="text-xs text-muted">Any council member may switch this on or off. Members still choose their own channels and which kinds of notice they get.</p>
    </Card>
  );
}

function WatchCard({ account, watches, max, busy, onSave }: { account: string; watches: string[]; max: number; busy: string | null; onSave: (owners: string[]) => void }) {
  const [candidates, setCandidates] = useState<{ owner: string; roles: string[] }[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(watches));
  const [extra, setExtra] = useState("");
  useEffect(() => setChosen(new Set(watches)), [watches]);
  useEffect(() => {
    let off = false;
    (async () => {
      const owners = [...new Set([...watches, ...watched(), ...(await listOpenReleases().catch(() => []))])].filter((o) => o !== account);
      const views = await Promise.all(owners.map(async (o) => ({ owner: o, view: await getPlan(o).catch(() => null) })));
      const found = views.map(({ owner, view }) => ({ owner, roles: rolesOf(view, account) as string[] })).filter((x) => x.roles.length || watches.includes(x.owner));
      if (!off) setCandidates(found);
    })();
    return () => {
      off = true;
    };
  }, [account, watches]);
  const toggle = (o: string) => setChosen((s) => (s.has(o) ? new Set([...s].filter((x) => x !== o)) : new Set([...s, o])));
  const changed = chosen.size !== watches.length || watches.some((w) => !chosen.has(w));
  const add = () => {
    toggle(extra);
    setCandidates((c) => (c && !c.some((x) => x.owner === extra) ? [...c, { owner: extra, roles: [] }] : c));
    setExtra("");
  };
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={Eye} title="Plans to follow" sub={`${chosen.size} of ${max} chosen`} />
      <p className="text-[15px] leading-relaxed text-muted">Your own plan is always followed. Guardians and heirs: pick the plans you&apos;re part of to hear when their owner hasn&apos;t checked in, before any release is proposed. Every open release reaches you anyway.</p>
      {candidates === null ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Looking for plans that name you">
          <Skeleton className="h-14 w-full rounded-row" />
          <Skeleton className="h-14 w-full rounded-row" />
        </div>
      ) : candidates.length === 0 ? (
        <p className="rounded-row border border-dashed border-line-strong p-4 text-[15px] text-muted">No plans that name this account were found. Add one by its owner&apos;s account below.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {candidates.map((c, i) => {
            const on = chosen.has(c.owner);
            return (
              <li key={c.owner}>
                <label className={cx("flex min-h-14 cursor-pointer items-center gap-3 rounded-row border p-3 transition-colors", on ? "border-signal bg-s-approved/50" : "border-line hover:bg-subtle")}>
                  <input type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" checked={on} onChange={() => toggle(c.owner)} />
                  <Avatar name={c.owner} i={i} size={32} />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">
                      {shortName(c.owner)}
                      {c.roles.length ? <span className="font-normal text-muted"> · you&apos;re {c.roles.join(" and ")}</span> : ""}
                    </span>
                    <span className="truncate font-mono text-xs text-muted">{c.owner}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <Field label="Another plan, by its owner's account">
        {(p) => (
          <div className="flex gap-2">
            <input
              {...p}
              className={inputClass}
              value={extra}
              onChange={(e) => setExtra(e.target.value.trim().toLowerCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && extra) {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="kemi.testnet"
              autoCapitalize="none"
              spellCheck={false}
            />
            <Button variant="outline" icon={Plus} disabled={!extra} onClick={add}>
              Add
            </Button>
          </div>
        )}
      </Field>
      {chosen.size > max && <Notice tone="warn">You can follow up to {max} plans.</Notice>}
      <Button variant="primary" className="self-start" disabled={(!!busy && busy !== "watches") || chosen.size > max || !changed} loading={busy === "watches"} onClick={() => onSave([...chosen])}>
        {busy === "watches" ? "Waiting for signature…" : "Save plans"}
      </Button>
    </Card>
  );
}

function PrefsCard({ info, prefs, busy, onSave }: { info: NotifierInfo; prefs: Record<string, boolean>; busy: string | null; onSave: (p: Record<string, boolean>) => void }) {
  const [p, setP] = useState(prefs);
  useEffect(() => setP(prefs), [prefs]);
  const changed = info.kinds.some((k) => p[k.kind] !== prefs[k.kind]);
  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle icon={ListChecks} title="What to send" sub="Everything is on by default. Each notice only goes to the people it concerns." />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {info.kinds.map((k) => {
          const on = k.always_on || p[k.kind] !== false;
          return (
            <label key={k.kind} className={cx("flex min-h-14 items-start gap-3 rounded-row border p-3 transition-colors", k.always_on ? "cursor-not-allowed border-line opacity-80" : "cursor-pointer hover:bg-subtle", on && !k.always_on ? "border-signal/50" : "border-line")}>
              <span className="relative mt-0.5 inline-flex">
                <input type="checkbox" role="switch" className="peer sr-only" checked={on} disabled={k.always_on} onChange={(e) => setP({ ...p, [k.kind]: e.target.checked })} />
                <span aria-hidden className="h-6 w-10 rounded-full bg-line-strong transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-signal/50" />
                <span aria-hidden className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[15px] font-medium">
                  {k.label}
                  {k.always_on && <span className="ml-1.5 text-xs font-normal text-muted">always on</span>}
                </span>
                <span className="text-xs text-muted">{k.who}</span>
              </span>
            </label>
          );
        })}
      </div>
      <Button variant="primary" className="self-start" disabled={(!!busy && busy !== "prefs") || !changed} loading={busy === "prefs"} onClick={() => onSave(p)}>
        {busy === "prefs" ? "Waiting for signature…" : "Save choices"}
      </Button>
    </Card>
  );
}

/** A small prompt other screens can place (e.g. after creating a plan or on a guardian's view). */
export function GetNotified({ role }: { role?: "owner" | "guardian" | "heir" }) {
  const text =
    role === "owner"
      ? "Get a reminder before your check-in window closes."
      : role === "guardian"
        ? "Hear when the owner stops checking in and when a release needs your vote."
        : role === "heir"
          ? "Hear when something is ready for you and when it arrives."
          : "Get reminders and release updates by email, Telegram or webhook.";
  return (
    <div className="flex flex-col gap-3 rounded-row border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-center gap-3 text-[15px]">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-s-approved text-[var(--s-approved-fg)]">
          <BellRing className="size-4" />
        </span>
        {text}
      </span>
      <ButtonLink href="/notifications" variant="outline" size="sm" className="shrink-0">
        Set up notifications
      </ButtonLink>
    </div>
  );
}
