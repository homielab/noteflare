/**
 * Reminder notifications while the app is closed (opt-in per device).
 * Used by the web app and the Worker only; it is not part of the public API.
 */

/** One reminder as the server stores it: when, and for which note. Never a title or text. */
export interface PushReminder {
  noteId: string
  dueAt: number // epoch ms
}

/** What a device sends while its switch is on: its push subscription and its upcoming reminders. */
export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string } // base64url, as PushSubscription.toJSON() gives them
  reminders: PushReminder[]
}

/** The soonest reminders a device keeps on the server. */
export const MAX_PUSH_REMINDERS = 100
export const MAX_PUSH_DEVICES = 10
