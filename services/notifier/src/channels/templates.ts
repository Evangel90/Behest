// Message bodies for each channel. Plain and calm: say what happened, what
// the reader can do, and when. Never say or imply that the owner died.
import { scopeOf } from "../db.js";
import { KIND_INFO, name } from "../diff.js";
import type { Outgoing } from "./types.js";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FOOTER_TESTNET = "Behest runs on testnet: no real funds move.";

export function emailNotice(m: Outgoing): { subject: string; text: string; html: string } {
  const n = m.notice;
  // An address the plan's owner supplied: say so, since the reader never asked for these.
  const why = scopeOf(m.contact)
    ? `You get this because the owner of this plan (${name(n.owner)}) named you in it on Behest and gave this address. Unsubscribe below to stop every message about it.`
    : `You get this because ${m.account} asked Behest to send "${KIND_INFO[n.kind]?.label ?? n.kind}" notices to this address.`;
  const text = [
    n.text,
    "",
    ...n.links.map((l) => `${l.label}: ${l.url}`),
    ...(n.links.length ? [""] : []),
    "—",
    why,
    `Choose what you receive: ${m.settingsUrl}`,
    `Unsubscribe this address: ${m.unsubscribeUrl}`,
    FOOTER_TESTNET,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#737373">Behest</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600">${esc(n.subject)}</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${esc(n.text)}</p>
${n.links.map((l) => `<p style="margin:0 0 8px"><a href="${esc(l.url)}" style="color:#2F6BFF">${esc(l.label)}</a></p>`).join("\n")}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0 12px">
<p style="margin:0 0 6px;font-size:13px;color:#737373">${esc(why)}</p>
<p style="margin:0;font-size:13px;color:#737373"><a href="${esc(m.settingsUrl)}" style="color:#737373">Choose what you receive</a> · <a href="${esc(m.unsubscribeUrl)}" style="color:#737373">Unsubscribe</a> · ${esc(FOOTER_TESTNET)}</p>
</div></body></html>`;
  return { subject: `Behest: ${n.subject}`, text, html };
}

export function emailVerification(account: string, address: string, url: string, hours: number): { subject: string; text: string; html: string } {
  const text = [
    `Someone signed in to Behest as ${account} asked to send plan notifications to ${address}.`,
    "",
    `If that was you, confirm this address (the link works for ${hours} hours):`,
    url,
    "",
    "If it wasn't you, ignore this email. Nothing more will be sent to this address unless it is confirmed.",
    "",
    FOOTER_TESTNET,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#737373">Behest</p>
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">Confirm your email</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">Someone signed in to Behest as <b>${esc(account)}</b> asked to send plan notifications to ${esc(address)}.</p>
<p style="margin:0 0 24px"><a href="${esc(url)}" style="display:inline-block;background:#2F6BFF;color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600">Confirm this address</a></p>
<p style="margin:0;font-size:13px;color:#737373">The link works for ${hours} hours. If it wasn't you, ignore this email: nothing more will be sent here unless it is confirmed. ${esc(FOOTER_TESTNET)}</p>
</div></body></html>`;
  return { subject: "Confirm your email for Behest notifications", text, html };
}

/** Telegram HTML parse mode. */
export function telegramNotice(m: Outgoing): string {
  const n = m.notice;
  return [`<b>${esc(n.subject)}</b>`, esc(n.text), ...n.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`), "", `<i>${esc(m.account)} · send /stop to unsubscribe this chat</i>`].join("\n");
}

/** JSON body for webhooks: structured fields plus Slack (`text`) and Discord (`content`) compatible text. */
export function webhookBody(m: Outgoing, contractId: string) {
  const n = m.notice;
  const plain = [n.subject, n.text, ...n.links.map((l) => `${l.label}: ${l.url}`)].join("\n");
  return {
    id: m.deliveryId,
    type: "behest.notice",
    test: Boolean(m.test),
    kind: n.kind,
    key: n.key,
    contract_id: contractId,
    owner: n.owner,
    account: m.account,
    recipients: n.recipients,
    proposal_id: n.proposalId ?? null,
    transfer_index: n.transferIndex ?? null,
    asset: n.asset ?? null,
    amount: n.amount ?? null,
    tx_hash: n.txHash ?? null,
    links: n.links,
    explorer_url: n.links.find((l) => /etherscan|mempool|nearblocks/.test(l.url))?.url ?? null,
    subject: n.subject,
    created_at: new Date(n.created_ms).toISOString(),
    // Slack incoming webhooks read `text`; Discord reads `content` (≤ 2000 chars).
    text: plain,
    content: plain.slice(0, 2000),
  };
}
