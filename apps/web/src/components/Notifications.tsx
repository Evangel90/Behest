"use client";
// Notification settings: where Behest reaches the signed-in account (email,
// Telegram, webhooks), which notices it sends, and which plans it watches.
// Contacts are kept by the notifier service, never on-chain; each change is
// signed by the account (a message, not a transaction).
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  savePreferences,
  testContact,
  type Contact,
  type NotifierInfo,
  type Settings,
} from "@/lib/notify";
import { rolesOf, shortName, when } from "@/lib/plan";
import { useSession } from "@/lib/session";
import type { ChipStyle } from "@/lib/plan";
import { Bracket, Button, ButtonLink, Card, Chip, Field, inputClass, Notice } from "./ui";

type Msg = { ok: boolean; text: string } | null;
const errText = (e: unknown) => (e instanceof NotifierError || e instanceof Error ? e.message : String(e));

const STATUS: Record<Contact["status"], ChipStyle> = {
  active: { label: "On", tone: "approved", shape: "circle" },
  pending: { label: "Waiting for confirmation", tone: "waiting", shape: "diamond" },
  disabled: { label: "Off", tone: "failed", shape: "square" },
};

function StatusChip({ c }: { c: Contact }) {
  const s = STATUS[c.status];
  return <Chip style={s}>{s.label}</Chip>;
}

export function Notifications() {
  const { session, ready } = useSession();
  const [info, setInfo] = useState<NotifierInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [secret, setSecret] = useState<{ id: number; secret: string } | null>(null);

  useEffect(() => {
    getInfo().then(setInfo, (e) => setInfoError(errText(e)));
  }, []);

  const load = useCallback(async (t: string) => {
    try {
      setSettings(await getSettings(t));
    } catch (e) {
      if (e instanceof NotifierError && e.code === "NO_SESSION" && session) {
        forgetSession(session.accountId);
        setToken(null);
      } else setMsg({ ok: false, text: errText(e) });
    }
  }, [session]);

  const connect = useCallback(async () => {
    if (!session) return;
    setBusy("connect");
    setMsg(null);
    try {
      const t = await openSession(session);
      setToken(t);
      await load(t);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
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
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
      if (token) await load(token);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!ready) return null;
  if (!session) {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-2xl font-medium tracking-[-0.02em]">Sign in to set up notifications</h2>
        <p className="text-muted">Owners get check-in reminders; guardians and heirs hear when a release moves. Sign in with the account the plan names.</p>
      </Card>
    );
  }
  if (infoError) return <Notice tone="error">The notification service isn't reachable ({infoError}). Plans keep working without it: notifications never change what the contract does.</Notice>;
  if (!info) return <p className="text-muted">Loading…</p>;

  if (!token || !settings) {
    return (
      <Card className="flex flex-col gap-4">
        <h2 className="text-2xl font-medium tracking-[-0.02em]">Notifications for {session.kind === "persona" ? session.label : session.accountId}</h2>
        <p className="text-muted">To see or change where Behest reaches you, sign a short message with this account. It proves the account is yours; it isn't a transaction and costs nothing.</p>
        {msg && <Notice tone={msg.ok ? "ok" : "error"}>{msg.text}</Notice>}
        <Button className="self-start" onClick={() => void connect()} disabled={busy === "connect"}>
          {busy === "connect" ? "Waiting for signature…" : "Sign and continue"}
        </Button>
      </Card>
    );
  }

  const byChannel = (ch: Contact["channel"]) => settings.contacts.filter((c) => c.channel === ch);
  return (
    <div className="flex flex-col gap-6">
      {msg && <Notice tone={msg.ok ? "ok" : "error"}>{msg.text}</Notice>}
      <p className="text-muted">
        Your contacts are kept by Behest's notification service, not on the blockchain, and only you can see them. If a notice fails to arrive, nothing about your plan changes.
      </p>

      <EmailCard info={info} contacts={byChannel("email")} busy={busy} onAdd={(a) => act("email", async () => (await addEmail(session, a)).message)} onResend={(c) => act(`resend-${c.id}`, async () => (await resendConfirmation(token, c.id), `A new confirmation link is on its way to ${c.address}.`))} onRemove={(c) => act(`remove-${c.id}`, async () => (await removeContact(session, c), "Removed."))} onTest={(c) => act(`test-${c.id}`, () => runTest(token, c))} />

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
        onRemove={(c) => act(`remove-${c.id}`, async () => (await removeContact(session, c), "Unlinked."))}
        onTest={(c) => act(`test-${c.id}`, () => runTest(token, c))}
        onRefresh={() => act("refresh", async () => {})}
      />

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
        onRemove={(c) => act(`remove-${c.id}`, async () => (await removeContact(session, c), "Removed."))}
        onTest={(c) => act(`test-${c.id}`, () => runTest(token, c))}
      />

      <WatchCard account={session.accountId} watches={settings.watches} max={info.limits.watches} busy={busy} onSave={(owners) => act("watches", async () => {
        const r = await saveWatches(session, owners);
        return r.refused.length ? `Saved. Not added (this account has no role in them): ${r.refused.join(", ")}.` : "Saved.";
      })} />

      <PrefsCard info={info} prefs={settings.preferences} busy={busy} onSave={(p) => act("prefs", async () => (await savePreferences(session, p), "Saved."))} />

      <Card className="flex flex-col gap-3">
        <Bracket>Recent notices</Bracket>
        {settings.recent.length === 0 && <p className="text-muted">Nothing yet.</p>}
        {settings.recent.map((n) => (
          <div key={n.key} className="flex flex-col gap-1 border-t border-line pt-3 first:border-0 first:pt-0">
            <span className="font-semibold">{n.subject}</span>
            <span className="text-sm">{n.text}</span>
            <span className="text-xs text-muted">{when(n.created_ms)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

async function runTest(token: string, c: Contact) {
  const r = await testContact(token, c.id);
  if (!r.ok) throw new Error(`The test didn't arrive: ${r.error ?? "unknown error"}`);
  return "Test sent.";
}

function ContactRow({ c, busy, onRemove, onTest, children }: { c: Contact; busy: string | null; onRemove: (c: Contact) => void; onTest?: (c: Contact) => void; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-tile border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all font-mono text-sm">{c.label && c.channel !== "email" ? `${c.label} · ` : ""}{c.channel === "telegram" ? `chat ${c.address}` : c.address}</span>
        <StatusChip c={c} />
      </div>
      {c.disabled_reason && <span className="text-[13px] text-error">Turned off: {c.disabled_reason}</span>}
      {c.last_delivery && <span className="text-[13px] text-muted">Last notice: {c.last_delivery.status}{c.last_delivery.error ? ` (${c.last_delivery.error})` : ""} · {when(c.last_delivery.at_ms)}</span>}
      <div className="flex flex-wrap gap-2">
        {children}
        {onTest && c.status === "active" && (
          <Button variant="outline" className="min-h-10" onClick={() => onTest(c)} disabled={!!busy}>
            {busy === `test-${c.id}` ? "Sending…" : "Send a test"}
          </Button>
        )}
        <Button variant="danger" className="min-h-10" onClick={() => onRemove(c)} disabled={!!busy}>
          {busy === `remove-${c.id}` ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}

function EmailCard({ info, contacts, busy, onAdd, onResend, onRemove, onTest }: { info: NotifierInfo; contacts: Contact[]; busy: string | null; onAdd: (a: string) => void; onResend: (c: Contact) => void; onRemove: (c: Contact) => void; onTest: (c: Contact) => void }) {
  const [address, setAddress] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim()) onAdd(address.trim());
  };
  return (
    <Card className="flex flex-col gap-4">
      <Bracket>Email</Bracket>
      {!info.channels.email && <Notice>Email isn't set up on this Behest server yet.</Notice>}
      {contacts.map((c) => (
        <ContactRow key={c.id} c={c} busy={busy} onRemove={onRemove} onTest={onTest}>
          {c.status !== "active" && (
            <Button variant="outline" className="min-h-10" onClick={() => onResend(c)} disabled={!!busy}>
              {busy === `resend-${c.id}` ? "Sending…" : "Send a new link"}
            </Button>
          )}
        </ContactRow>
      ))}
      {info.channels.email && contacts.length < info.limits.email && (
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Add an email address" hint="We send a link first; nothing else arrives until you confirm it.">
              <input className={inputClass} type="email" autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="you@example.com" />
            </Field>
          </div>
          <Button type="submit" disabled={!!busy || !address.trim()} className="sm:mb-6">
            {busy === "email" ? "Sending…" : "Add"}
          </Button>
        </form>
      )}
    </Card>
  );
}

function TelegramCard({ info, contacts, busy, onLink, onRemove, onTest, onRefresh }: { info: NotifierInfo; contacts: Contact[]; busy: string | null; onLink: () => void; onRemove: (c: Contact) => void; onTest: (c: Contact) => void; onRefresh: () => void }) {
  return (
    <Card className="flex flex-col gap-4">
      <Bracket>Telegram</Bracket>
      {!info.channels.telegram && <Notice>Telegram isn't set up on this Behest server yet.</Notice>}
      {contacts.map((c) => (
        <ContactRow key={c.id} c={c} busy={busy} onRemove={onRemove} onTest={onTest} />
      ))}
      {info.channels.telegram && (
        <div className="flex flex-wrap items-center gap-2">
          {contacts.length < info.limits.telegram && (
            <Button onClick={onLink} disabled={!!busy}>
              {busy === "telegram" ? "Waiting for signature…" : contacts.length ? "Link another chat" : "Link Telegram"}
            </Button>
          )}
          <Button variant="outline" onClick={onRefresh} disabled={!!busy}>
            I've pressed Start
          </Button>
          <span className="text-[13px] text-muted">Send /stop to the bot at any time to unlink.</span>
        </div>
      )}
    </Card>
  );
}

function WebhookCard({ info, contacts, busy, secret, onAdd, onRemove, onTest }: { info: NotifierInfo; contacts: Contact[]; busy: string | null; secret: { id: number; secret: string } | null; onAdd: (url: string, label?: string) => void; onRemove: (c: Contact) => void; onTest: (c: Contact) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) onAdd(url.trim(), label.trim() || undefined);
  };
  return (
    <Card className="flex flex-col gap-4">
      <Bracket>Webhooks</Bracket>
      <p className="text-sm text-muted">
        Behest POSTs JSON to your URL, signed with <span className="font-mono">X-Behest-Signature: v1=HMAC-SHA256(secret, timestamp + "." + body)</span>. Slack and Discord incoming webhooks work as they are{info.webhook_https_only ? "; https only" : ""}.
      </p>
      {contacts.map((c) => (
        <ContactRow key={c.id} c={c} busy={busy} onRemove={onRemove} onTest={onTest}>
          {secret?.id === c.id && (
            <div className="flex w-full flex-col gap-1 rounded-row bg-subtle p-3">
              <span className="text-[13px] font-semibold">Signing secret: copy it now, it won't be shown again</span>
              <code className="break-all font-mono text-sm">{secret.secret}</code>
            </div>
          )}
        </ContactRow>
      ))}
      {contacts.length < info.limits.webhook && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Webhook URL">
            <input className={inputClass} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
          </Field>
          <Field label="Name (optional)">
            <input className={inputClass} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Family Slack" />
          </Field>
          <Button type="submit" className="self-start" disabled={!!busy || !url.trim()}>
            {busy === "webhook" ? "Adding…" : "Add webhook"}
          </Button>
        </form>
      )}
    </Card>
  );
}

/** Plans that involve this account, so guardians and heirs hear about them before a release opens. */
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
  return (
    <Card className="flex flex-col gap-4">
      <Bracket>Plans to follow</Bracket>
      <p className="text-sm text-muted">Your own plan is always followed. Guardians and heirs: pick the plans you're part of to hear when their owner hasn't checked in, before any release is proposed. Every open release reaches you anyway.</p>
      {candidates === null && <p className="text-muted">Looking for plans that name you…</p>}
      {candidates?.length === 0 && <p className="text-muted">No plans that name this account were found. Add one by its owner's account below.</p>}
      {candidates?.map((c) => (
        <label key={c.owner} className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="h-5 w-5" checked={chosen.has(c.owner)} onChange={() => toggle(c.owner)} />
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold">{shortName(c.owner)}{c.roles.length ? ` · you're ${c.roles.join(" and ")}` : ""}</span>
            <span className="truncate font-mono text-xs text-muted">{c.owner}</span>
          </span>
        </label>
      ))}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Another plan, by its owner's account">
            <input className={inputClass} value={extra} onChange={(e) => setExtra(e.target.value.trim().toLowerCase())} placeholder="kemi.testnet" />
          </Field>
        </div>
        <Button variant="outline" disabled={!extra} onClick={() => (toggle(extra), setCandidates((c) => (c && !c.some((x) => x.owner === extra) ? [...c, { owner: extra, roles: [] }] : c)), setExtra(""))}>
          Add
        </Button>
      </div>
      <Button className="self-start" disabled={!!busy || chosen.size > max} onClick={() => onSave([...chosen])}>
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
      <Bracket>What to send</Bracket>
      <p className="text-sm text-muted">Everything is on by default. Each notice only goes to the people it concerns, shown under its name.</p>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {info.kinds.map((k) => (
          <label key={k.kind} className="flex min-h-11 items-start gap-3 py-1">
            <input type="checkbox" className="mt-0.5 h-5 w-5" checked={k.always_on || p[k.kind] !== false} disabled={k.always_on} onChange={(e) => setP({ ...p, [k.kind]: e.target.checked })} />
            <span className="flex flex-col">
              <span className="text-[15px]">{k.label}</span>
              <span className="text-xs text-muted">{k.who}</span>
            </span>
          </label>
        ))}
      </div>
      <Button className="self-start" disabled={!!busy || !changed} onClick={() => onSave(p)}>
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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-row bg-subtle px-4 py-3">
      <span className="text-sm">{text}</span>
      <ButtonLink href="/notifications" variant="outline" className="min-h-10">
        Set up notifications
      </ButtonLink>
    </div>
  );
}

