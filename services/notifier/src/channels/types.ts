import type { Contact, StoredNotice } from "../db.js";

/** What a channel needs to send one notice to one contact. */
export interface Outgoing {
  notice: StoredNotice;
  /** The recipient account (whose contact this is). */
  account: string;
  contact: Contact;
  /** Stable per (notice, account, contact): receivers can de-duplicate on it. */
  deliveryId: string;
  /** One-click unsubscribe for this contact. */
  unsubscribeUrl: string;
  /** Where to change preferences. */
  settingsUrl: string;
  test?: boolean;
}

export interface Sender {
  send(m: Outgoing): Promise<void>;
}

/** The contact can never receive again (bot blocked, mailbox gone, 410 Gone): disable it. */
export class PermanentError extends Error {}
/** This delivery won't succeed by retrying (e.g. HTTP 400), but the contact stays. */
export class RejectedError extends Error {}
/** Try again later; `retryAfterMs` if the far side said when. */
export class TransientError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
