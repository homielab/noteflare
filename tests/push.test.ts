import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker/index'
import { b64url, fromB64url, MAX_PUSHES_PER_RUN, PUSH_CRON, pushRequest, reminderPayload, sendDuePushes, subscriptionId, vapidKeys } from '../worker/push'
import { disablePush, enablePush, pushEnabled, pushReminders, syncPush } from '../src/lib/push'
import { emptyNote, type Note } from '../src/lib/noteModel'

// Only exists inside the Workers runtime.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

const ME = 'me@example.com'
const NOTE_A = '11111111-2222-4333-8444-555555555555'
const NOTE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-one'
const SECRET_TITLE = 'Dentist at four'
const SECRET_BODY = 'bring the x-rays'

interface Sub { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; created_at: number }
interface Rem { subscription_id: string; user_id: string; note_id: string; due_at: number }

/** A tiny D1 stand-in with the settings, push and notes tables. */
function fakeDb() {
  const settings = new Map<string, string>()
  const subs: Sub[] = []
  const rems: Rem[] = []
  const notes = [{ id: NOTE_A, user: ME, trashedAt: null as number | null }]
  const drop = <T,>(list: T[], f: (x: T) => boolean) => {
    const before = list.length
    for (let i = list.length - 1; i >= 0; i--) if (f(list[i])) list.splice(i, 1)
    return { changes: before - list.length }
  }
  const run = (sql: string, a: unknown[]): { results?: unknown[]; first?: unknown; changes?: number } => {
    if (sql.includes('FROM settings WHERE key IN')) return { results: [] }
    if (sql === 'SELECT value FROM settings WHERE key = ?') return { first: settings.has(a[0] as string) ? { value: settings.get(a[0] as string) } : null }
    if (sql.startsWith('INSERT INTO settings')) {
      if (settings.has(a[0] as string)) return { changes: 0 }
      settings.set(a[0] as string, a[1] as string)
      return { changes: 1 }
    }
    if (sql.startsWith('SELECT id, user_id FROM push_subscriptions')) return { results: subs.filter((s) => s.user_id === a[0] || s.id === a[1]).map(({ id, user_id }) => ({ id, user_id })) }
    if (sql.startsWith('SELECT note_id, due_at FROM reminders')) return { results: rems.filter((r) => r.subscription_id === a[0] && r.user_id === a[1]) }
    if (sql.startsWith('INSERT INTO push_subscriptions')) {
      const [id, user_id, endpoint, p256dh, auth, created_at] = a as [string, string, string, string, string, number]
      const s = subs.find((x) => x.id === id)
      if (s) Object.assign(s, { user_id, p256dh, auth })
      else subs.push({ id, user_id, endpoint, p256dh, auth, created_at })
      return { changes: 1 }
    }
    if (sql.startsWith('INSERT INTO reminders')) {
      const [subscription_id, user_id, note_id, due_at] = a as [string, string, string, number]
      const r = rems.find((x) => x.subscription_id === subscription_id && x.note_id === note_id)
      if (r) Object.assign(r, { due_at, user_id })
      else rems.push({ subscription_id, user_id, note_id, due_at })
      return { changes: 1 }
    }
    if (sql === 'DELETE FROM reminders WHERE subscription_id = ?') return drop(rems, (r) => r.subscription_id === a[0])
    if (sql === 'DELETE FROM reminders WHERE subscription_id = ? AND note_id = ?') return drop(rems, (r) => r.subscription_id === a[0] && r.note_id === a[1])
    if (sql === 'DELETE FROM reminders WHERE subscription_id = ? AND note_id = ? AND due_at = ?') return drop(rems, (r) => r.subscription_id === a[0] && r.note_id === a[1] && r.due_at === a[2])
    if (sql === 'DELETE FROM reminders WHERE subscription_id = ? AND user_id = ?') return drop(rems, (r) => r.subscription_id === a[0] && r.user_id === a[1])
    if (sql === 'DELETE FROM reminders WHERE user_id = ? AND note_id = ?') return drop(rems, (r) => r.user_id === a[0] && r.note_id === a[1])
    if (sql === 'DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?') return drop(subs, (s) => s.id === a[0] && s.user_id === a[1])
    if (sql === 'DELETE FROM push_subscriptions WHERE id = ?') return drop(subs, (s) => s.id === a[0])
    if (sql.startsWith('SELECT r.subscription_id')) {
      const [now, limit] = a as [number, number]
      const results = rems
        .filter((r) => r.due_at <= now)
        .sort((x, y) => x.due_at - y.due_at)
        .slice(0, limit)
        .flatMap((r) => {
          const s = subs.find((x) => x.id === r.subscription_id)
          return s ? [{ subscription_id: r.subscription_id, note_id: r.note_id, due_at: r.due_at, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }] : []
        })
      return { results }
    }
    if (sql.startsWith('SELECT id, ciphertext') && sql.includes('FROM notes')) {
      const n = notes.find((x) => x.user === a[0] && x.id === a[1])
      return { first: n ? { id: n.id, ciphertext: 'Y3Q=', iv: 'aXY=', pinned: 0, archived: 0, trashed_at: n.trashedAt, position: 0, version: 2, created_at: 1, updated_at: 1 } : null }
    }
    if (sql.startsWith('UPDATE notes SET')) {
      const n = notes.find((x) => x.user === a[a.length - 3] && x.id === a[a.length - 2])
      if (!n) return { changes: 0 }
      n.trashedAt = a[4] as number | null
      return { changes: 1 }
    }
    if (sql.startsWith('DELETE FROM notes WHERE user_id')) return drop(notes, (n) => n.user === a[0] && n.id === a[1] && n.trashedAt !== null)
    if (sql.startsWith('DELETE FROM shares')) return { changes: 0 }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: run(sql, args).results ?? [] }),
    first: async () => run(sql, args).first ?? null,
    run: async () => ({ meta: { changes: run(sql, args).changes ?? 0 } }),
  })
  return {
    settings,
    subs,
    rems,
    notes,
    prepare: (sql: string) => stmt(sql.trim().replace(/\s+/g, ' ')),
    batch: async (list: { sql: string; args: unknown[] }[]) => list.map((s) => ({ meta: { changes: run(s.sql, s.args).changes ?? 0 } })),
  }
}

type Db = ReturnType<typeof fakeDb>
const env = (db: Db) => ({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: ME, DB: db }) as never
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
const call = (db: Db, method: string, path: string, body?: unknown) =>
  worker.fetch(
    new Request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) as never,
    env(db),
    ctx,
  )

/** A browser's side of a push subscription: the keys only that device holds. */
async function device(endpoint = ENDPOINT) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { endpoint, keys: { p256dh: b64url(publicRaw), auth: b64url(auth) }, privateKey: pair.privateKey, publicRaw, auth }
}
type Device = Awaited<ReturnType<typeof device>>

const utf8 = (s: string) => new TextEncoder().encode(s)
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)))
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8))
}

/** What the browser does with a push message (RFC 8291). */
async function decryptPush(d: Device, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16)
  const idLen = body[20]
  const serverPublic = body.slice(21, 21 + idLen)
  const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, d.privateKey, 256))
  const ikm = await hkdf(d.auth, shared, join(utf8('WebPush: info\0'), d.publicRaw, serverPublic), 32)
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idLen)))
  expect(plain[plain.length - 1]).toBe(2)
  return new TextDecoder().decode(plain.slice(0, -1))
}

const note = (patch: Partial<Note>): Note => ({ ...emptyNote(), title: SECRET_TITLE, body: SECRET_BODY, ...patch })
const subscribeBody = (d: Device, reminders: { noteId: string; dueAt: number }[]) => ({ endpoint: d.endpoint, keys: d.keys, reminders })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what a push carries', () => {
  it('builds a payload with the note id and nothing else', () => {
    expect(JSON.parse(reminderPayload(NOTE_A))).toEqual({ t: 'reminder', n: NOTE_A })
  })

  it('encrypts the payload for the device and signs the request for its push service', async () => {
    const db = fakeDb()
    const d = await device()
    const vapid = (await vapidKeys(db as never, true))!
    const now = Date.now()
    const req = await pushRequest(vapid, { endpoint: d.endpoint, ...d.keys }, NOTE_A, now)

    expect(req.url).toBe(ENDPOINT)
    expect(req.headers.get('Content-Encoding')).toBe('aes128gcm')
    const body = new Uint8Array(await req.arrayBuffer())
    expect(new TextDecoder().decode(body)).not.toContain(NOTE_A) // the push service can't read it
    expect(await decryptPush(d, body)).toBe(reminderPayload(NOTE_A))

    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(req.headers.get('Authorization') ?? '')
    expect(m).not.toBeNull()
    const [, head, claims, sig, k] = m!
    expect(k).toBe(vapid.publicKey)
    const publicKey = await crypto.subtle.importKey('raw', fromB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64url(sig), utf8(`${head}.${claims}`))).toBe(true)
    const c = JSON.parse(new TextDecoder().decode(fromB64url(claims)))
    expect(c.aud).toBe('https://fcm.googleapis.com')
    expect(c.exp).toBeGreaterThan(now / 1000)
    expect(c.exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600)
    expect(c.sub).not.toContain(ME) // the user's email is never sent to a push service
  })

  it('keeps one set of VAPID keys per deployment', async () => {
    const db = fakeDb()
    expect(await vapidKeys(db as never, false)).toBeNull()
    const first = await vapidKeys(db as never, true)
    expect(await vapidKeys(db as never, true)).toEqual(first)
  })
})

describe('the endpoints', () => {
  it('stores only the subscription, the due time and the note id', async () => {
    const db = fakeDb()
    const d = await device()
    const dueAt = Date.now() + 3600_000
    const res = await call(db, 'PUT', '/api/push/subscription', {
      ...subscribeBody(d, [{ noteId: NOTE_A, dueAt, title: SECRET_TITLE } as never]),
      title: SECRET_TITLE,
      text: SECRET_BODY,
    })
    expect(res.status).toBe(200)
    const id = await subscriptionId(ENDPOINT)
    expect(db.subs).toEqual([{ id, user_id: ME, endpoint: ENDPOINT, p256dh: d.keys.p256dh, auth: d.keys.auth, created_at: expect.any(Number) }])
    expect(db.rems).toEqual([{ subscription_id: id, user_id: ME, note_id: NOTE_A, due_at: dueAt }])
    const stored = JSON.stringify([db.subs, db.rems])
    expect(stored).not.toContain(SECRET_TITLE)
    expect(stored).not.toContain(SECRET_BODY)
  })

  it('refuses addresses that are not a browser push service, and malformed input', async () => {
    const db = fakeDb()
    const d = await device()
    for (const endpoint of ['https://evil.example/push', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x']) {
      expect((await call(db, 'PUT', '/api/push/subscription', { ...subscribeBody(d, []), endpoint })).status).toBe(400)
      expect((await call(db, 'POST', '/api/push/unsubscribe', { endpoint })).status).toBe(400)
    }
    expect((await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, [{ noteId: 'nope', dueAt: 5 }]))).status).toBe(400)
    expect((await call(db, 'PUT', '/api/push/subscription', { ...subscribeBody(d, []), keys: { p256dh: 'AAAA', auth: d.keys.auth } })).status).toBe(400)
    expect(db.subs).toEqual([])
    expect(db.rems).toEqual([])
  })

  it('is not reachable with an API token', async () => {
    const db = fakeDb()
    expect((await call(db, 'GET', '/api/v1/push/key')).status).toBe(401)
    expect(db.settings.size).toBe(0)
  })

  it('removes the rows when the reminder is cleared, the note is trashed or deleted, or the switch goes off', async () => {
    const db = fakeDb()
    const d = await device()
    const dueAt = Date.now() + 3600_000
    const both = [{ noteId: NOTE_A, dueAt }, { noteId: NOTE_B, dueAt: dueAt + 1 }]

    // Reminder cleared: the device's next list no longer has it.
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, both))
    expect(db.rems).toHaveLength(2)
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, [both[1]]))
    expect(db.rems.map((r) => r.note_id)).toEqual([NOTE_B])

    // Note moved to the trash from any device, then deleted for good.
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, both))
    const trashed = await call(db, 'PUT', `/api/notes/${NOTE_A}`, { ciphertext: 'Y3Q=', iv: 'aXY=', pinned: false, archived: false, trashedAt: Date.now(), position: 0, baseVersion: 1 })
    expect(trashed.status).toBe(200)
    expect(db.rems.map((r) => r.note_id)).toEqual([NOTE_B])
    db.rems.push({ subscription_id: 'x', user_id: ME, note_id: NOTE_A, due_at: dueAt })
    expect((await call(db, 'DELETE', `/api/notes/${NOTE_A}`)).status).toBe(204)
    expect(db.rems.map((r) => r.note_id)).toEqual([NOTE_B])

    // Switch off (sign-out makes the same call).
    expect((await call(db, 'POST', '/api/push/unsubscribe', { endpoint: ENDPOINT })).status).toBe(204)
    expect(db.subs).toEqual([])
    expect(db.rems).toEqual([])
  })
})

describe('the cron', () => {
  async function seeded() {
    const db = fakeDb()
    const d = await device()
    await vapidKeys(db as never, true)
    return { db, d }
  }

  it('sends what is due with no title or text, deletes it and leaves the rest', async () => {
    const { db, d } = await seeded()
    const now = Date.now()
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, [{ noteId: NOTE_A, dueAt: now - 1000 }, { noteId: NOTE_B, dueAt: now + 3600_000 }]))
    const sent: Request[] = []
    const res = await sendDuePushes(db as never, now, async (req) => (sent.push(req), new Response(null, { status: 201 })))

    expect(res).toEqual({ sent: 1, dropped: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(ENDPOINT)
    expect(await decryptPush(d, new Uint8Array(await sent[0].arrayBuffer()))).toBe(reminderPayload(NOTE_A))
    expect(db.rems.map((r) => r.note_id)).toEqual([NOTE_B])
    // Nothing more to send: the same reminder never goes out twice.
    expect(await sendDuePushes(db as never, now, async () => new Response(null, { status: 201 }))).toEqual({ sent: 0, dropped: 0 })
  })

  it('forgets a device the push service no longer knows, and retries after an outage', async () => {
    const { db, d } = await seeded()
    const now = Date.now()
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, [{ noteId: NOTE_A, dueAt: now - 1000 }, { noteId: NOTE_B, dueAt: now + 3600_000 }]))

    await sendDuePushes(db as never, now, async () => new Response(null, { status: 503 }))
    expect(db.rems).toHaveLength(2)
    await sendDuePushes(db as never, now, async () => {
      throw new TypeError('network')
    })
    expect(db.rems).toHaveLength(2)

    await sendDuePushes(db as never, now, async () => new Response(null, { status: 410 }))
    expect(db.subs).toEqual([])
    expect(db.rems).toEqual([])
  })

  it('sends a bounded number per run', async () => {
    const { db, d } = await seeded()
    const now = Date.now()
    const id = await subscriptionId(ENDPOINT)
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, []))
    for (let i = 0; i < MAX_PUSHES_PER_RUN + 3; i++) db.rems.push({ subscription_id: id, user_id: ME, note_id: crypto.randomUUID(), due_at: now - i })
    const res = await sendDuePushes(db as never, now, async () => new Response(null, { status: 201 }))
    expect(res.sent).toBe(MAX_PUSHES_PER_RUN)
    expect(db.rems).toHaveLength(3)
  })

  it('runs from the 5-minute trigger without the daily clean-up, and contacts nobody when nothing is due', async () => {
    const { db, d } = await seeded()
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    await call(db, 'PUT', '/api/push/subscription', subscribeBody(d, [{ noteId: NOTE_B, dueAt: Date.now() + 3600_000 }]))
    await worker.scheduled!({ cron: PUSH_CRON } as never, env(db), ctx)
    expect(fetchMock).not.toHaveBeenCalled()

    db.rems[0].due_at = Date.now() - 1
    await worker.scheduled!({ cron: PUSH_CRON } as never, env(db), ctx)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.rems).toEqual([])
    expect(db.notes).toHaveLength(1)
  })
})

describe('the switch on a device', () => {
  let db: Db
  let d: Device
  let requests: { method: string; path: string; body: string }[]
  let unsubscribed: boolean

  beforeEach(async () => {
    db = fakeDb()
    d = await device()
    requests = []
    unsubscribed = false
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    const sub = { endpoint: d.endpoint, toJSON: () => ({ endpoint: d.endpoint, keys: d.keys }), unsubscribe: async () => (unsubscribed = true) }
    let subscribed = false
    const pushManager = {
      getSubscription: async () => (subscribed ? sub : null),
      subscribe: async () => ((subscribed = true), sub),
    }
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('window', { PushManager: class {}, Notification: {} })
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ pushManager }) } })
    // The app's requests go to the Worker, as in the browser.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', path: url, body: String(init?.body ?? '') })
      return call(db, init?.method ?? 'GET', url, init?.body ? JSON.parse(String(init.body)) : undefined)
    })
  })

  const soon = () => Date.now() + 3600_000

  it('lists only upcoming reminders of notes that alert, as id and time', () => {
    const now = 1_800_000_000_000
    const list = pushReminders(
      [
        note({ id: NOTE_A, reminder: now + 5000 }),
        note({ id: NOTE_B, reminder: now + 1000 }),
        note({ reminder: now - 1 }),
        note({ reminder: now + 1000, trashedAt: now }),
        note({ reminder: now + 1000, archived: true }),
        note({}),
      ],
      now,
    )
    expect(list).toEqual([{ noteId: NOTE_B, dueAt: now + 1000 }, { noteId: NOTE_A, dueAt: now + 5000 }])
  })

  it('off (the default): the server receives no reminder time and no subscription', async () => {
    const notes = [note({ id: NOTE_A, reminder: soon() })]
    expect(pushEnabled()).toBe(false)
    await syncPush(notes)
    await disablePush()
    expect(requests).toEqual([])
    expect(db.subs).toEqual([])
    expect(db.rems).toEqual([])
    expect(db.settings.size).toBe(0)
  })

  it('on: sends id and time only, follows changes, and off deletes the rows', async () => {
    const dueAt = soon()
    const notes = [note({ id: NOTE_A, reminder: dueAt })]
    await enablePush(notes)
    expect(pushEnabled()).toBe(true)
    expect(db.rems).toEqual([{ subscription_id: await subscriptionId(ENDPOINT), user_id: ME, note_id: NOTE_A, due_at: dueAt }])
    const wire = JSON.stringify(requests)
    expect(wire).not.toContain(SECRET_TITLE)
    expect(wire).not.toContain(SECRET_BODY)

    // Nothing changed: nothing is sent again.
    const before = requests.length
    await syncPush(notes)
    expect(requests).toHaveLength(before)

    // The reminder is cleared on the note.
    await syncPush([note({ id: NOTE_A })])
    expect(db.rems).toEqual([])
    expect(db.subs).toHaveLength(1)

    await syncPush(notes)
    expect(db.rems).toHaveLength(1)
    await disablePush()
    expect(pushEnabled()).toBe(false)
    expect(unsubscribed).toBe(true)
    expect(db.subs).toEqual([])
    expect(db.rems).toEqual([])
  })
})
