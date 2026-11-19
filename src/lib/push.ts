import { useEffect } from 'react'
import { t } from '@/i18n'
import { MAX_PUSH_REMINDERS, type PushReminder } from '../../shared/push'
import { api } from './api'
import type { Note } from './notes'

/**
 * Reminder notifications while the app is closed. Off by default and per device.
 *
 * Off: nothing here talks to the server. On: this device's push subscription and its
 * upcoming reminders (due time and note id, never a title or text) are kept on the server,
 * which wakes the device through the browser's push service when one is due.
 */
const ENABLED_KEY = 'noteflare:push'
/** Where the service worker finds the notification's words; it can't read the app's language. */
export const PUSH_TEXT_CACHE = 'nf-push-text'
export const PUSH_TEXT_URL = '/push-text.json'

export class PushBlockedError extends Error {}
export class PushUnavailableError extends Error {}

export function pushSupported(): boolean {
  return (
    import.meta.env.VITE_DEMO !== '1' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function pushEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

function setEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1')
    else localStorage.removeItem(ENABLED_KEY)
  } catch {
    /* storage blocked */
  }
}

/** What the server is told: upcoming reminders of notes that would alert in the app, soonest first. */
export function pushReminders(notes: Note[], now: number): PushReminder[] {
  return notes
    .filter((n) => typeof n.reminder === 'number' && n.reminder > now && !n.trashedAt && !n.archived)
    .map((n) => ({ noteId: n.id, dueAt: n.reminder! }))
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, MAX_PUSH_REMINDERS)
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

/** The notification is shown while the app is locked, so its words are saved in the app's language now. */
async function saveNotificationText() {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(PUSH_TEXT_CACHE)
  await cache.put(PUSH_TEXT_URL, new Response(JSON.stringify({ title: t('push.notifTitle'), body: t('push.notifBody') }), { headers: { 'Content-Type': 'application/json' } }))
}

async function subscription(create: boolean): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) throw new PushUnavailableError()
  const existing = await reg.pushManager.getSubscription()
  if (existing || !create) return existing
  const { publicKey } = await api.pushKey()
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
}

async function send(sub: PushSubscription, reminders: PushReminder[]) {
  const json = sub.toJSON()
  await api.putPushSubscription({ endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, reminders })
}

let lastSent = ''
const fingerprint = (endpoint: string, reminders: PushReminder[]) => `${endpoint}|${reminders.map((r) => `${r.noteId}:${r.dueAt}`).join(',')}`

/** Turns the switch on: asks for permission, subscribes this browser and sends the upcoming reminders. */
export async function enablePush(notes: Note[]): Promise<void> {
  if (!pushSupported()) throw new PushUnavailableError()
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') throw new PushBlockedError()
  const sub = await subscription(true)
  if (!sub) throw new PushUnavailableError()
  const reminders = pushReminders(notes, Date.now())
  await send(sub, reminders)
  lastSent = fingerprint(sub.endpoint, reminders)
  await saveNotificationText().catch(() => {})
  setEnabled(true)
}

/** Turns the switch off: the server deletes this device's rows and the browser forgets the subscription. */
export async function disablePush(): Promise<void> {
  if (!pushEnabled()) return
  const sub = pushSupported() ? await subscription(false).catch(() => null) : null
  if (sub) {
    await api.removePushSubscription(sub.endpoint)
    await sub.unsubscribe().catch(() => {})
  }
  lastSent = ''
  setEnabled(false)
  if (typeof caches !== 'undefined') await caches.delete(PUSH_TEXT_CACHE).catch(() => {})
}

/** With the switch on, keeps the server's rows equal to this device's reminders. Off: does nothing. */
export async function syncPush(notes: Note[]): Promise<void> {
  if (!pushEnabled() || !pushSupported()) return
  if (Notification.permission !== 'granted') return
  // The browser may have dropped the subscription (site data cleared); make a new one.
  const sub = await subscription(true)
  if (!sub) return
  const reminders = pushReminders(notes, Date.now())
  const print = fingerprint(sub.endpoint, reminders)
  if (print === lastSent) return
  await send(sub, reminders)
  lastSent = print
}

const SYNC_DELAY_MS = 2000

/** Sends reminder changes shortly after they happen, and the notification's words when the language changes. */
export function usePushSync(notes: Note[], lang: string) {
  useEffect(() => {
    if (!pushEnabled()) return
    const timer = setTimeout(() => void syncPush(notes).catch(() => {}), SYNC_DELAY_MS)
    return () => clearTimeout(timer)
  }, [notes])
  useEffect(() => {
    if (pushEnabled()) void saveNotificationText().catch(() => {})
  }, [lang])
}
