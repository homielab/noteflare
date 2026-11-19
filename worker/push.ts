/**
 * Reminder notifications while the app is closed: Web Push (RFC 8030) with VAPID (RFC 8292)
 * and an encrypted payload (RFC 8291, aes128gcm), all with WebCrypto.
 *
 * Opt-in per device. The server stores a device's push subscription and, per reminder, the
 * due time and the note id. It never holds a title or text, and the push carries only the
 * note id, encrypted for that device, so the push service sees no content at all.
 */
import { MAX_PUSH_DEVICES, MAX_PUSH_REMINDERS, type PushReminder, type PushSubscriptionBody } from '../shared/push'

/** Runs `sendDuePushes`; the other cron in wrangler.jsonc is the daily clean-up. */
export const PUSH_CRON = '*/5 * * * *'
/**
 * Pushes sent per run. One run has 10 ms of CPU and 50 subrequests on the free plan;
 * what doesn't fit stays due and goes out with the next run.
 */
export const MAX_PUSHES_PER_RUN = 10
/** A push the service keeps refusing (rate limit, outage) is dropped after this long. */
const GIVE_UP_MS = 60 * 60 * 1000
/** How long the push service keeps a notification for a device that is offline. */
const TTL_S = 24 * 60 * 60
const VAPID_KEY = 'vapid'
/** VAPID needs a contact; the project's address tells the push service nothing about the user. */
const VAPID_SUBJECT = 'https://github.com/homielab/noteflare'
const ID_RE = /^[0-9a-f-]{36}$/i

/**
 * Push services of the browsers NoteFlare runs in (Chrome and other Chromium browsers,
 * Safari, Firefox, Edge). The Worker sends pushes nowhere else.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/]

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeKey(v: unknown, bytes: number): Uint8Array | null {
  if (typeof v !== 'string' || v.length > 128 || !/^[A-Za-z0-9_-]+$/.test(v)) return null
  try {
    const b = fromB64url(v)
    return b.length === bytes ? b : null
  } catch {
    return null
  }
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------- validation ----------

export function isPushEndpoint(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 1024) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some((h) => h.test(u.hostname))
  } catch {
    return false
  }
}

/** Checks what a device sent and keeps only the known fields, so nothing else can be stored. */
export function parseSubscription(body: unknown): PushSubscriptionBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Partial<PushSubscriptionBody>
  const p256dh = decodeKey(b.keys?.p256dh, 65)
  if (!isPushEndpoint(b.endpoint) || !p256dh || p256dh[0] !== 4 || !decodeKey(b.keys?.auth, 16)) return null
  if (!Array.isArray(b.reminders) || b.reminders.length > MAX_PUSH_REMINDERS) return null
  const reminders: PushReminder[] = []
  const seen = new Set<string>()
  for (const r of b.reminders as Partial<PushReminder>[]) {
    if (!r || typeof r.noteId !== 'string' || !ID_RE.test(r.noteId) || !Number.isSafeInteger(r.dueAt) || r.dueAt! <= 0) return null
    if (seen.has(r.noteId)) return null
    seen.add(r.noteId)
    reminders.push({ noteId: r.noteId, dueAt: r.dueAt! })
  }
  return { endpoint: b.endpoint, keys: { p256dh: b.keys!.p256dh, auth: b.keys!.auth }, reminders }
}

export async function subscriptionId(endpoint: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(endpoint)))
  return Array.from(hash, (x) => x.toString(16).padStart(2, '0')).join('')
}

// ---------- VAPID ----------

export interface Vapid {
  /** base64url, uncompressed P-256 point: the browser's `applicationServerKey`. */
  publicKey: string
  privateJwk: JsonWebKey
}

/** This deployment's VAPID keys, made the first time a device turns notifications on. */
export async function vapidKeys(db: D1Database, create: boolean): Promise<Vapid | null> {
  const read = async () => {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(VAPID_KEY).first<{ value: string }>()
    return row ? (JSON.parse(row.value) as Vapid) : null
  }
  const saved = await read()
  if (saved || !create) return saved
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair
  const vapid: Vapid = {
    publicKey: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
  }
  // Two devices enabling at once: the first insert wins and both get the same keys.
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').bind(VAPID_KEY, JSON.stringify(vapid)).run()
  return read()
}

/** The `Authorization` header that proves to a push service who is sending. */
export async function vapidAuthorization(vapid: Vapid, endpoint: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT })}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned))
  return `vapid t=${unsigned}.${b64url(sig)}, k=${vapid.publicKey}`
}

// ---------- payload ----------

/** Everything a reminder push carries: which note to open. No title, no text, no time. */
export function reminderPayload(noteId: string): string {
  return JSON.stringify({ t: 'reminder', n: noteId })
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** Encrypts a push message for one device (RFC 8291): only that browser can read it. */
export async function encryptPush(keys: { p256dh: string; auth: string }, plaintext: string): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(keys.p256dh)
  const authSecret = fromB64url(keys.auth)
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const localPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256))

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, localPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm\0')), 16)
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce\0')), 12)

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // One record; 0x02 marks it as the last.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(plaintext), new Uint8Array([2]))))
  // Header: salt, record size (4096), key id length, key id (our public key).
  return concat(salt, new Uint8Array([0, 0, 16, 0, localPublic.length]), localPublic, sealed)
}

// ---------- storage ----------

interface SubscriptionRow {
  id: string
  user_id: string
}

type SaveResult = { ok: true; reminders: number } | { ok: false; error: 'too_many_devices' }

/** Saves a device's subscription and makes its reminder rows match the list it sent. */
export async function saveSubscription(db: D1Database, user: string, body: PushSubscriptionBody, now: number): Promise<SaveResult> {
  const id = await subscriptionId(body.endpoint)
  const { results: subs } = await db.prepare('SELECT id, user_id FROM push_subscriptions WHERE user_id = ? OR id = ?').bind(user, id).all<SubscriptionRow>()
  const mine = subs.filter((s) => s.user_id === user)
  if (!mine.some((s) => s.id === id) && mine.length >= MAX_PUSH_DEVICES) return { ok: false, error: 'too_many_devices' }

  const { results: have } = await db
    .prepare('SELECT note_id, due_at FROM reminders WHERE subscription_id = ? AND user_id = ?')
    .bind(id, user)
    .all<{ note_id: string; due_at: number }>()
  const want = new Map(body.reminders.map((r) => [r.noteId, r.dueAt]))
  const current = new Map(have.map((r) => [r.note_id, r.due_at]))

  const stmts: D1PreparedStatement[] = []
  // A browser profile that changed owner: the previous owner's reminders don't follow it.
  if (subs.some((s) => s.id === id && s.user_id !== user)) stmts.push(db.prepare('DELETE FROM reminders WHERE subscription_id = ?').bind(id))
  stmts.push(
    db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .bind(id, user, body.endpoint, body.keys.p256dh, body.keys.auth, now),
  )
  // Only what changed is written: most syncs change one reminder or none.
  for (const noteId of current.keys()) {
    if (!want.has(noteId)) stmts.push(db.prepare('DELETE FROM reminders WHERE subscription_id = ? AND note_id = ?').bind(id, noteId))
  }
  for (const [noteId, dueAt] of want) {
    if (current.get(noteId) === dueAt) continue
    stmts.push(
      db
        .prepare(
          `INSERT INTO reminders (subscription_id, user_id, note_id, due_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (subscription_id, note_id) DO UPDATE SET due_at = excluded.due_at, user_id = excluded.user_id`,
        )
        .bind(id, user, noteId, dueAt),
    )
  }
  await db.batch(stmts)
  return { ok: true, reminders: want.size }
}

/** Switch off or sign-out on one device: its subscription and reminder rows go. */
export async function removeSubscription(db: D1Database, user: string, endpoint: string): Promise<void> {
  const id = await subscriptionId(endpoint)
  await db.batch([
    db.prepare('DELETE FROM reminders WHERE subscription_id = ? AND user_id = ?').bind(id, user),
    db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').bind(id, user),
  ])
}

/** A note went to the trash or was deleted: no device is reminded of it any more. */
export async function dropNoteReminders(db: D1Database, user: string, noteId: string): Promise<void> {
  await db.prepare('DELETE FROM reminders WHERE user_id = ? AND note_id = ?').bind(user, noteId).run()
}

// ---------- sending ----------

interface DueRow {
  subscription_id: string
  note_id: string
  due_at: number
  endpoint: string
  p256dh: string
  auth: string
}

/** The request one reminder becomes. Exported so tests can check what leaves the Worker. */
export async function pushRequest(vapid: Vapid, sub: { endpoint: string; p256dh: string; auth: string }, noteId: string, now: number): Promise<Request> {
  return new Request(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(vapid, sub.endpoint, now),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL_S),
      Urgency: 'high',
    },
    body: await encryptPush(sub, reminderPayload(noteId)),
  })
}

/**
 * The 5-minute cron: sends a push for every reminder that is due and deletes its row.
 * A subscription the push service no longer knows is removed with its reminders.
 */
export async function sendDuePushes(db: D1Database, now: number, send: (req: Request) => Promise<Response> = (req) => fetch(req)): Promise<{ sent: number; dropped: number }> {
  const { results } = await db
    .prepare(
      `SELECT r.subscription_id, r.note_id, r.due_at, s.endpoint, s.p256dh, s.auth
       FROM reminders r JOIN push_subscriptions s ON s.id = r.subscription_id
       WHERE r.due_at <= ? ORDER BY r.due_at LIMIT ?`,
    )
    .bind(now, MAX_PUSHES_PER_RUN)
    .all<DueRow>()
  if (!results.length) return { sent: 0, dropped: 0 }
  const vapid = await vapidKeys(db, false)
  if (!vapid) return { sent: 0, dropped: 0 }

  let sent = 0
  let dropped = 0
  const gone = new Set<string>()
  const done: DueRow[] = []
  await Promise.all(
    results.map(async (row) => {
      let status = 0
      try {
        status = (await send(await pushRequest(vapid, row, row.note_id, now))).status
      } catch {
        // network error: try again next run
      }
      if (status >= 200 && status < 300) {
        sent++
        done.push(row)
      } else if (status === 404 || status === 410) {
        gone.add(row.subscription_id) // the browser unsubscribed or the app was removed
      } else if ((status >= 400 && status < 500 && status !== 429) || row.due_at < now - GIVE_UP_MS) {
        dropped++
        done.push(row)
      }
    }),
  )

  const stmts = done
    .filter((r) => !gone.has(r.subscription_id))
    .map((r) => db.prepare('DELETE FROM reminders WHERE subscription_id = ? AND note_id = ? AND due_at = ?').bind(r.subscription_id, r.note_id, r.due_at))
  for (const id of gone) {
    stmts.push(db.prepare('DELETE FROM reminders WHERE subscription_id = ?').bind(id), db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id))
  }
  if (stmts.length) await db.batch(stmts)
  return { sent, dropped }
}
