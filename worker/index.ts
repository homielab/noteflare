import { Hono, type Context, type Next } from 'hono'
import { cors } from 'hono/cors'
import { getAccessUser, isAccessMissing, isAllowedEmail, LOCAL_HOSTS, type AccessEnv } from './auth'
import { d1Settings, isUnset, needsSetup, resolveAccess, runSetup, SetupError, TOKEN_URL } from './setup'
import { generateToken, hashToken, toApiToken, tokenPrefix, verifyToken, type TokenRow } from './tokens'
import { openApiSpec } from './openapi'
import { backupKey, isBackupDate, listBackups, runScheduledBackups, toNote, toVault, type NoteRow, type VaultRow } from './backups'
import { dispatchUpdate, selfUpdateRepo, UpdateDispatchError, versionInfo, type UpdateEnv } from './updates'
import { notifyLive } from './live'
import { isRateLimited, rateLimitedBody, RETRY_AFTER_S, type RateLimiter } from './rateLimit'
import { dropNoteReminders, parseSubscription, PUSH_CRON, removeSubscription, saveSubscription, sendDuePushes, isPushEndpoint, vapidKeys } from './push'
import { publicShare, purgeShares, revokeNoteShares, sharePage, sharePageHeaders, toShareInfo, type ShareRow } from './shares'
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_NOTES,
  MAX_ATTACHMENT_BYTES,
  MAX_PASSKEYS,
  MAX_SHARES_PER_USER,
  SHARE_DAYS,
  SHARE_ID_RE,
  MAX_TOKENS_PER_USER,
  type BatchNoteItem,
  type BatchResult,
  type CreateTokenBody,
  type CreateTokenResponse,
  type CreateShareBody,
  type ShareInfo,
  type EncryptedNote,
  type MeResponse,
  type PasskeyRecord,
  type PutNoteBody,
  type TokenScope,
  type VaultRecord,
} from '../shared/types'

interface Env extends AccessEnv, UpdateEnv {
  DB: D1Database
  ASSETS: Fetcher
  /** Optional R2 bucket for encrypted attachments. Without it the feature is off. */
  ATTACHMENTS?: R2Bucket
  /** Durable Object namespace for live sync. Without it other devices pick changes up by polling. */
  LIVE?: DurableObjectNamespace
  /** Optional per-IP limits (wrangler.jsonc `ratelimits`). Without them nothing is limited. */
  TOKEN_LIMITER?: RateLimiter
  SETUP_LIMITER?: RateLimiter
}

export { LiveSync } from './liveObject'

type Vars = { user: string; scope: TokenScope; via: 'session' | 'token' }
type Ctx = Context<{ Bindings: Env; Variables: Vars }>

const MAX_CIPHERTEXT = 512 * 1024 // ~384 KB plaintext / note
const ID_RE = /^[0-9a-f-]{36}$/i
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
/** Encryption adds an IV, an auth tag and the hidden file name and type to each attachment. */
const MAX_BLOB_BYTES = MAX_ATTACHMENT_BYTES + 4096
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** Same bounds the clients enforce before deriving a key (see KDF_LIMITS in packages/client). */
const KDF_LIMITS = { memoryKiB: [19 * 1024, 256 * 1024], iterations: [2, 16], parallelism: [1, 4] } as const
const inRange = (v: unknown, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi

/**
 * Two mounts of the same routes:
 * - /api      — the web app. Authenticated by Cloudflare Access (browser session).
 * - /api/v1   — the public API for other clients. Authenticated by personal access
 *               tokens (`Authorization: Bearer nf_…`), never by cookies, so it is
 *               safe to open to any origin with CORS.
 */
const api = new Hono<{ Bindings: Env; Variables: Vars }>()
const isV1 = (c: Ctx) => c.req.path.startsWith('/api/v1/')

api.use('*', async (c, next) => {
  const access = await accessFor(c)
  if (isV1(c)) {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')
    if (!m) return unauthorized(c, 'unauthorized', 'Send a NoteFlare API token: Authorization: Bearer nf_…')
    if (await isRateLimited(c.env.TOKEN_LIMITER, c.req.raw)) return tooMany(c)
    const t = await verifyToken(c.env.DB, m[1], c.executionCtx)
    // A token stops working when its owner is removed from ALLOWED_EMAILS.
    if (!t || !isAllowedEmail(t.user, access)) return unauthorized(c, 'invalid_token', 'This token is unknown, revoked or expired.')
    c.set('user', t.user)
    c.set('scope', t.scope)
    c.set('via', 'token')
  } else {
    const user = await getAccessUser(c.req.raw, access)
    if (!user) {
      // Tell a first-time deployer apart from an expired session (see isAccessMissing);
      // `setup` sends a new deployment to the in-app setup instead of a guide.
      const reason = isAccessMissing(c.req.raw, access)
        ? { reason: 'access_not_set_up', setup: canSetUp(c, access) }
        : {}
      return c.json({ error: 'unauthorized', ...reason }, 401)
    }
    c.set('user', user)
    c.set('scope', 'write')
    c.set('via', 'session')
  }

  // A JSON body forces a CORS preflight for cross-site requests, which blocks
  // form/text-plain CSRF against the cookie-authenticated web API.
  if (c.req.method === 'POST' && !c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'unsupported_media_type', message: 'Send JSON with Content-Type: application/json.' }, 415)
  }

  await next()
  // Attachments are immutable ciphertext and set their own private caching.
  // (a WebSocket upgrade response has immutable headers)
  if (c.res.status !== 101 && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
})

function tooMany(c: Context) {
  return c.json(rateLimitedBody, 429, { 'Retry-After': String(RETRY_AFTER_S) })
}

function unauthorized(c: Ctx, error: string, message: string) {
  return c.json({ error, message }, 401, { 'WWW-Authenticate': 'Bearer realm="noteflare"' })
}

const needWrite = async (c: Ctx, next: Next) => {
  if (c.get('scope') !== 'write') {
    return c.json({ error: 'forbidden', message: 'This token is read-only. Create a token with write access.' }, 403)
  }
  await next()
}

/** Things only the signed-in owner may do in the browser: managing keys and tokens. */
const sessionOnly = async (c: Ctx, next: Next) => {
  if (c.get('via') !== 'session') {
    return c.json({ error: 'forbidden', message: 'Only available from the NoteFlare web app.' }, 403)
  }
  await next()
}

// ---------- User & vault ----------

// This deployment's version and, unless disabled, the newest release on GitHub.
api.get('/version', async (c) => {
  const info = await versionInfo(c.env, { force: c.req.query('refresh') === '1' })
  return c.json({ ...info, canUpdate: c.get('via') === 'session' && !!selfUpdateRepo(c.env) })
})

// "Update now": runs the update workflow in the deployment's own GitHub repository.
// The GitHub token stays in the Worker; only the signed-in owner can start it.
api.post('/update', sessionOnly, async (c) => {
  if (!selfUpdateRepo(c.env)) return c.json({ error: 'not_configured', message: 'Set GITHUB_UPDATE_TOKEN and GITHUB_UPDATE_REPO first.' }, 404)
  try {
    await dispatchUpdate(c.env)
    return c.json({ ok: true }, 202)
  } catch (e) {
    const status = e instanceof UpdateDispatchError ? e.status : 0
    return c.json({ error: 'update_failed', message: `GitHub refused to start the update (${status || 'no answer'}). Check the token and repository.` }, 502)
  }
})

api.get('/me', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 FROM vaults WHERE user_id = ?')
    .bind(c.get('user'))
    .first()
  return c.json<MeResponse>({
    email: c.get('user'),
    hasVault: !!row,
    auth: c.get('via'),
    scope: c.get('scope'),
    attachments: !!c.env.ATTACHMENTS,
  })
})

api.get('/vault', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT kdf, wrapped_dek, recovery_dek, version FROM vaults WHERE user_id = ?',
  )
    .bind(c.get('user'))
    .first<VaultRow>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json<VaultRecord>({ ...toVault(row), passkeys: await listPasskeys(c.env.DB, c.get('user')) })
})

/** Create the vault (version = 0) or change the passphrase (version = current version). */
api.put('/vault', sessionOnly, async (c) => {
  const body = await c.req.json<VaultRecord>().catch(() => null)
  if (
    !body ||
    !isB64(body.wrappedDek, 256) ||
    !isB64(body.recoveryDek, 256) ||
    body.kdf?.name !== 'argon2id' ||
    !isB64(body.kdf.salt, 64) ||
    body.kdf.salt.length < 24 || // ≥ 16 bytes
    !inRange(body.kdf.memoryKiB, KDF_LIMITS.memoryKiB) ||
    !inRange(body.kdf.iterations, KDF_LIMITS.iterations) ||
    !inRange(body.kdf.parallelism, KDF_LIMITS.parallelism) ||
    !Number.isInteger(body.version) ||
    body.version < 0
  ) {
    return c.json({ error: 'bad_request' }, 400)
  }
  const user = c.get('user')
  const now = Date.now()
  const kdf = JSON.stringify({
    name: 'argon2id',
    salt: body.kdf.salt,
    memoryKiB: body.kdf.memoryKiB,
    iterations: body.kdf.iterations,
    parallelism: body.kdf.parallelism,
  })

  if (body.version === 0) {
    const res = await c.env.DB.prepare(
      `INSERT INTO vaults (user_id, kdf, wrapped_dek, recovery_dek, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(user, kdf, body.wrappedDek, body.recoveryDek, now, now)
      .run()
    if (!res.meta.changes) return c.json({ error: 'conflict' }, 409)
    return c.json({ version: 1 })
  }

  const res = await c.env.DB.prepare(
    `UPDATE vaults SET kdf = ?, wrapped_dek = ?, recovery_dek = ?, version = version + 1, updated_at = ?
     WHERE user_id = ? AND version = ?`,
  )
    .bind(kdf, body.wrappedDek, body.recoveryDek, now, user, body.version)
    .run()
  if (!res.meta.changes) return c.json({ error: 'conflict' }, 409)
  return c.json({ version: body.version + 1 })
})

// ---------- Passkeys ----------
// Extra wrapped copies of the data key, one per passkey (WebAuthn PRF). The wrapping key
// is derived in the browser from the passkey's PRF output; the server never sees it.

interface PasskeyRow {
  id: string
  name: string
  salt: string
  wrapped_dek: string
  created_at: number
}

const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1400}$/

async function listPasskeys(db: D1Database, user: string): Promise<PasskeyRecord[]> {
  try {
    const { results } = await db
      .prepare('SELECT id, name, salt, wrapped_dek, created_at FROM passkeys WHERE user_id = ? ORDER BY created_at')
      .bind(user)
      .all<PasskeyRow>()
    return (results ?? []).map((r) => ({ id: r.id, name: r.name, salt: r.salt, wrappedDek: r.wrapped_dek, createdAt: r.created_at }))
  } catch {
    return [] // migration not applied yet: no passkeys
  }
}

api.post('/passkeys', sessionOnly, async (c) => {
  const body = await c.req.json<Partial<PasskeyRecord>>().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 64) : ''
  if (
    !body ||
    typeof body.id !== 'string' ||
    !CREDENTIAL_ID_RE.test(body.id) ||
    !name ||
    !isB64(body.salt, 64) ||
    body.salt.length < 43 || // ≥ 32 bytes
    !isB64(body.wrappedDek, 256)
  ) {
    return c.json({ error: 'bad_request' }, 400)
  }
  const user = c.get('user')
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(user).first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_PASSKEYS) {
    return c.json({ error: 'too_many_passkeys', message: `Remove a passkey first (limit ${MAX_PASSKEYS}).` }, 409)
  }
  const rec: PasskeyRecord = { id: body.id, name, salt: body.salt, wrappedDek: body.wrappedDek, createdAt: Date.now() }
  const res = await c.env.DB.prepare(
    `INSERT INTO passkeys (user_id, id, name, salt, wrapped_dek, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO NOTHING`,
  )
    .bind(user, rec.id, rec.name, rec.salt, rec.wrappedDek, rec.createdAt)
    .run()
  if (!res.meta.changes) return c.json({ error: 'conflict' }, 409)
  return c.json(rec, 201)
})

api.delete('/passkeys/:id', sessionOnly, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ? AND id = ?')
    .bind(c.get('user'), c.req.param('id') ?? '')
    .run()
  return res.meta.changes ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

// ---------- Live sync ----------

// WebSocket for the web app: the user's other open devices hear about changes (ids and versions only).
api.get('/live', sessionOnly, async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'upgrade_required' }, 426)
  // Browsers send the cookie with cross-site socket upgrades: only our own pages may connect.
  let originHost = ''
  try {
    originHost = new URL(c.req.header('Origin') ?? '').host
  } catch {
    // no or malformed Origin
  }
  if (!originHost || originHost !== new URL(c.req.url).host) return c.json({ error: 'forbidden' }, 403)
  if (!c.env.LIVE) return c.json({ error: 'live_disabled' }, 501)
  const stub = c.env.LIVE.get(c.env.LIVE.idFromName(c.get('user')))
  return stub.fetch(new Request('https://live/connect', c.req.raw))
})

// ---------- Notes ----------

/** Notes changed after `since` (server ms timestamp), oldest first. `since=0` returns everything. */
api.get('/notes', async (c) => {
  const since = Number(c.req.query('since') ?? 0) || 0
  const { results } = await c.env.DB.prepare(
    `SELECT id, ciphertext, iv, pinned, archived, trashed_at, position, version, created_at, updated_at
     FROM notes WHERE user_id = ? AND updated_at > ? ORDER BY updated_at`,
  )
    .bind(c.get('user'), since)
    .all<NoteRow>()
  return c.json<EncryptedNote[]>(results.map(toNote))
})

/** Ids and versions of every note, so clients can drop notes deleted on another device. */
api.get('/notes/index', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, version FROM notes WHERE user_id = ?')
    .bind(c.get('user'))
    .all<{ id: string; version: number }>()
  return c.json(results)
})

api.get('/notes/:id', async (c) => {
  const id = c.req.param('id') ?? ''
  if (!ID_RE.test(id)) return c.json({ error: 'bad_request' }, 400)
  const row = await getNote(c.env.DB, c.get('user'), id)
  return row ? c.json<EncryptedNote>(toNote(row)) : c.json({ error: 'not_found' }, 404)
})

api.put('/notes/:id', needWrite, async (c) => {
  const id = c.req.param('id') ?? ''
  const body = await c.req.json<PutNoteBody>().catch(() => null)
  if (!ID_RE.test(id) || !isValidNoteBody(body) || !Number.isInteger(body.baseVersion)) {
    return c.json({ error: 'bad_request' }, 400)
  }
  const user = c.get('user')
  const now = Date.now()
  const flags = [body.pinned ? 1 : 0, body.archived ? 1 : 0, body.trashedAt, body.position] as const

  const res =
    body.baseVersion === 0
      ? await c.env.DB.prepare(
          `INSERT INTO notes (id, user_id, ciphertext, iv, pinned, archived, trashed_at, position, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id, id) DO NOTHING`,
        )
          .bind(id, user, body.ciphertext, body.iv, ...flags, now, now)
          .run()
      : await c.env.DB.prepare(
          `UPDATE notes SET ciphertext = ?, iv = ?, pinned = ?, archived = ?, trashed_at = ?, position = ?,
             version = version + 1, updated_at = ?
           WHERE user_id = ? AND id = ? AND version = ?`,
        )
          .bind(body.ciphertext, body.iv, ...flags, now, user, id, body.baseVersion)
          .run()

  // A note moved to the trash stops being shared; restoring it doesn't bring its links back.
  if (res.meta.changes && body.trashedAt !== null) {
    await revokeNoteShares(c.env.DB, user, id)
    await dropNoteReminders(c.env.DB, user, id).catch(() => {}) // the push tables may not exist yet
  }
  const row = await getNote(c.env.DB, user, id)
  if (!res.meta.changes) {
    // Conflict: return the current server copy so the client can resolve it.
    return row ? c.json({ error: 'conflict', current: toNote(row) }, 409) : c.json({ error: 'not_found' }, 404)
  }
  notifyLive(c.env, c.executionCtx, user, [{ id, version: row!.version }])
  return c.json<EncryptedNote>(toNote(row!))
})

/**
 * Create many notes in one call (used by Markdown import).
 * Runs as one D1 batch (a single transaction); ids that already exist are skipped.
 */
api.post('/notes/batch', needWrite, async (c) => {
  const len = Number(c.req.header('Content-Length') ?? 0)
  if (len > BATCH_MAX_BYTES) return c.json({ error: 'too_large' }, 413)

  const body = await c.req.json<{ notes: BatchNoteItem[] }>().catch(() => null)
  const notes = body?.notes
  if (!Array.isArray(notes) || notes.length === 0 || notes.length > BATCH_MAX_NOTES) {
    return c.json({ error: 'bad_request' }, 400)
  }
  for (const n of notes) {
    if (!isValidNoteBody(n) || !ID_RE.test(n.id)) return c.json({ error: 'bad_request' }, 400)
  }
  if (new Set(notes.map((n) => n.id)).size !== notes.length) return c.json({ error: 'bad_request' }, 400)

  const user = c.get('user')
  const now = Date.now()
  const stmt = c.env.DB.prepare(
    `INSERT INTO notes (id, user_id, ciphertext, iv, pinned, archived, trashed_at, position, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id, id) DO NOTHING`,
  )
  const results = await c.env.DB.batch(
    notes.map((n) =>
      stmt.bind(n.id, user, n.ciphertext, n.iv, n.pinned ? 1 : 0, n.archived ? 1 : 0, n.trashedAt, n.position, now, now),
    ),
  )

  const out: BatchResult = { created: [], skipped: [] }
  results.forEach((r, i) => {
    if (r.meta.changes) out.created.push({ id: notes[i].id, version: 1, createdAt: now, updatedAt: now })
    else out.skipped.push(notes[i].id)
  })
  notifyLive(c.env, c.executionCtx, user, out.created.map(({ id, version }) => ({ id, version })))
  return c.json(out)
})

/** Delete forever (only notes already in the trash). */
api.delete('/notes/:id', needWrite, async (c) => {
  const id = c.req.param('id') ?? ''
  const res = await c.env.DB.prepare(
    'DELETE FROM notes WHERE user_id = ? AND id = ? AND trashed_at IS NOT NULL',
  )
    .bind(c.get('user'), id)
    .run()
  if (!res.meta.changes) return c.json({ error: 'not_found' }, 404)
  await revokeNoteShares(c.env.DB, c.get('user'), id)
  await dropNoteReminders(c.env.DB, c.get('user'), id).catch(() => {})
  notifyLive(c.env, c.executionCtx, c.get('user'), [{ id, version: 0 }])
  return c.body(null, 204)
})

// ---------- Shared links (web app only; the public side is /api/share/:id and /s/:id) ----------

api.get('/shares', sessionOnly, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, note_id, expires_at, created_at FROM shares
     WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`,
  )
    .bind(c.get('user'), Date.now())
    .all<ShareRow>()
  return c.json<ShareInfo[]>((results ?? []).map(toShareInfo))
})

api.post('/shares', sessionOnly, async (c) => {
  const body = await c.req.json<CreateShareBody>().catch(() => null)
  if (
    !body ||
    typeof body.id !== 'string' ||
    !SHARE_ID_RE.test(body.id) ||
    typeof body.noteId !== 'string' ||
    !ID_RE.test(body.noteId) ||
    !isB64(body.ciphertext, MAX_CIPHERTEXT) ||
    !isB64(body.iv, 24) ||
    !(SHARE_DAYS as readonly unknown[]).includes(body.days)
  ) {
    return c.json({ error: 'bad_request' }, 400)
  }
  const user = c.get('user')
  const note = await getNote(c.env.DB, user, body.noteId)
  if (!note || note.trashed_at !== null) return c.json({ error: 'not_found' }, 404)
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE user_id = ?').bind(user).first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_SHARES_PER_USER) {
    return c.json({ error: 'too_many_shares', message: `Revoke a link first (limit ${MAX_SHARES_PER_USER}).` }, 409)
  }
  const now = Date.now()
  const row: ShareRow = {
    id: body.id,
    note_id: body.noteId,
    ciphertext: body.ciphertext,
    iv: body.iv,
    expires_at: body.days ? now + body.days * DAY_MS : null,
    created_at: now,
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO shares (id, user_id, note_id, ciphertext, iv, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(row.id, user, row.note_id, row.ciphertext, row.iv, row.expires_at, row.created_at)
    .run()
  if (!res.meta.changes) return c.json({ error: 'conflict' }, 409)
  return c.json<ShareInfo>(toShareInfo(row), 201)
})

api.delete('/shares/:id', sessionOnly, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM shares WHERE user_id = ? AND id = ?')
    .bind(c.get('user'), c.req.param('id') ?? '')
    .run()
  return res.meta.changes ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

// ---------- Reminder notifications while the app is closed (web app only, opt-in per device) ----------
// Nothing is stored until a device turns the switch on. Then: its push subscription and, per
// reminder, the due time and the note id. Never a title or text (see worker/push.ts).

api.get('/push/key', sessionOnly, async (c) => {
  const vapid = await vapidKeys(c.env.DB, true)
  return c.json({ publicKey: vapid!.publicKey })
})

/** The device's subscription and its full list of upcoming reminders; rows not in the list are deleted. */
api.put('/push/subscription', sessionOnly, async (c) => {
  const body = parseSubscription(await c.req.json().catch(() => null))
  if (!body) return c.json({ error: 'bad_request' }, 400)
  const res = await saveSubscription(c.env.DB, c.get('user'), body, Date.now())
  if (!res.ok) return c.json({ error: res.error, message: 'Turn notifications off on another device first.' }, 409)
  return c.json({ reminders: res.reminders })
})

/** Switch off or sign-out: deletes the device's subscription and its reminder rows. */
api.post('/push/unsubscribe', sessionOnly, async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => null)
  if (!isPushEndpoint(body?.endpoint)) return c.json({ error: 'bad_request' }, 400)
  await removeSubscription(c.env.DB, c.get('user'), body.endpoint)
  return c.body(null, 204)
})

// ---------- API tokens (web app only) ----------

// ---------- Attachments ----------
// Encrypted files in R2, one object per attachment under the owner's own prefix.
// The server never sees what they are: the bytes and the file type are inside the ciphertext.

const blobKey = (c: Ctx, id: string) => `${c.get('user')}/${id}`
const noAttachments = (c: Ctx) =>
  c.json({ error: 'attachments_disabled', message: 'This deployment has no storage for attachments. Add the ATTACHMENTS R2 binding.' }, 501)

api.put('/blobs/:id', needWrite, async (c) => {
  const bucket = c.env.ATTACHMENTS
  if (!bucket) return noAttachments(c)
  const id = c.req.param('id') ?? ''
  if (!ID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const tooLarge = () => c.json({ error: 'too_large', message: `An attachment can be at most ${MAX_ATTACHMENT_BYTES} bytes.` }, 413)
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_BLOB_BYTES) return tooLarge()
  const body = await c.req.arrayBuffer()
  if (!body.byteLength) return c.json({ error: 'invalid_body', message: 'Send the encrypted attachment as the request body.' }, 400)
  if (body.byteLength > MAX_BLOB_BYTES) return tooLarge()
  await bucket.put(blobKey(c, id), body)
  return c.json({ id, size: body.byteLength }, 201)
})

api.get('/blobs/:id', async (c) => {
  const bucket = c.env.ATTACHMENTS
  if (!bucket) return noAttachments(c)
  const id = c.req.param('id') ?? ''
  if (!ID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  const object = await bucket.get(blobKey(c, id))
  if (!object) return c.json({ error: 'not_found' }, 404)
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      // Ciphertext for one id never changes, and only its owner can ask for it.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

api.delete('/blobs/:id', needWrite, async (c) => {
  const bucket = c.env.ATTACHMENTS
  if (!bucket) return noAttachments(c)
  const id = c.req.param('id') ?? ''
  if (!ID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400)
  await bucket.delete(blobKey(c, id))
  return c.body(null, 204)
})

// ---------- Scheduled backups ----------
// The daily cron saves each user's encrypted vault and notes (the file the app exports) in the same bucket.

api.get('/backups', async (c) => {
  const bucket = c.env.ATTACHMENTS
  return c.json({ backups: bucket ? await listBackups(bucket, c.get('user')) : [] })
})

api.get('/backups/:date', async (c) => {
  const bucket = c.env.ATTACHMENTS
  if (!bucket) return noAttachments(c)
  const date = c.req.param('date') ?? ''
  if (!isBackupDate(date)) return c.json({ error: 'invalid_date' }, 400)
  const object = await bucket.get(backupKey(c.get('user'), date))
  if (!object) return c.json({ error: 'not_found' }, 404)
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="noteflare-backup-${date}.json"`,
      'Cache-Control': 'private, no-store',
    },
  })
})

api.get('/tokens', sessionOnly, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_id, name, prefix, scope, created_at, last_used_at, expires_at
     FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(c.get('user'))
    .all<TokenRow>()
  return c.json(results.map(toApiToken))
})

api.post('/tokens', sessionOnly, async (c) => {
  const body = await c.req.json<CreateTokenBody>().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const days = body?.expiresInDays
  if (
    !name ||
    name.length > 60 ||
    (body?.scope !== 'read' && body?.scope !== 'write') ||
    !(days === null || (Number.isInteger(days) && days! >= 1 && days! <= 3650))
  ) {
    return c.json({ error: 'bad_request' }, 400)
  }
  const user = c.get('user')
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?')
    .bind(user)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_TOKENS_PER_USER) {
    return c.json({ error: 'too_many_tokens', message: `Revoke a token first (limit ${MAX_TOKENS_PER_USER}).` }, 409)
  }

  const token = generateToken()
  const now = Date.now()
  const row: TokenRow = {
    id: crypto.randomUUID(),
    user_id: user,
    name,
    prefix: tokenPrefix(token),
    scope: body!.scope,
    created_at: now,
    last_used_at: null,
    expires_at: days ? now + days * DAY_MS : null,
  }
  await c.env.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, name, prefix, hash, scope, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, user, row.name, row.prefix, await hashToken(token), row.scope, row.created_at, row.expires_at)
    .run()
  return c.json<CreateTokenResponse>({ token, info: toApiToken(row) }, 201)
})

api.delete('/tokens/:id', sessionOnly, async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM api_tokens WHERE user_id = ? AND id = ?')
    .bind(c.get('user'), c.req.param('id') ?? '')
    .run()
  return res.meta.changes ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

// ---------- App ----------

const app = new Hono<{ Bindings: Env; Variables: Vars }>()

// Hardening headers for API responses (the app's pages get theirs from public/_headers).
app.use('/api/*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
})

app.use(
  '/api/v1/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'CF-Access-Client-Id', 'CF-Access-Client-Secret'],
    allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
)
// Public, no token needed: lets clients and code generators discover the API.
app.get('/api/v1/openapi.json', (c) => c.json(openApiSpec(new URL(c.req.url).origin)))
// No version here: with a Bypass policy this is public, and a version helps target old deployments.
app.get('/api/v1/health', (c) => c.json({ ok: true, api: 'v1' }))

// ---------- In-app setup of Cloudflare Access (see worker/setup.ts) ----------
// Public until it is done; it only accepts an API token from the account this deployment runs in.

/**
 * Access settings in effect: from wrangler.jsonc, or from D1 after the in-app setup.
 * Local development (DEV_USER_EMAIL on localhost, Access unset) skips the D1 lookup.
 */
async function accessFor(c: Ctx): Promise<AccessEnv> {
  const local = LOCAL_HOSTS.has(new URL(c.req.url).hostname)
  if (local && c.env.DEV_USER_EMAIL && (isUnset(c.env.ACCESS_TEAM_DOMAIN) || isUnset(c.env.ACCESS_AUD))) {
    return { ...c.env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ALLOWED_EMAILS: isUnset(c.env.ALLOWED_EMAILS) ? '' : c.env.ALLOWED_EMAILS }
  }
  return resolveAccess(c.env, d1Settings(c.env.DB))
}

function canSetUp(c: Ctx, access: AccessEnv) {
  return needsSetup(access) && !LOCAL_HOSTS.has(new URL(c.req.url).hostname)
}

app.get('/api/setup', async (c) => {
  c.header('Cache-Control', 'no-store')
  const access = await accessFor(c)
  if (!canSetUp(c, access)) return c.json({ needed: false })
  return c.json({ needed: true, host: new URL(c.req.url).hostname, emails: access.ALLOWED_EMAILS ?? '', tokenUrl: TOKEN_URL })
})

app.post('/api/setup', async (c) => {
  c.header('Cache-Control', 'no-store')
  if (await isRateLimited(c.env.SETUP_LIMITER, c.req.raw)) return tooMany(c)
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'unsupported_media_type' }, 415)
  }
  if (!canSetUp(c, await accessFor(c))) {
    return c.json({ error: 'already_set_up', message: 'The login is already set up. Reload the page to sign in.' }, 409)
  }
  const body = await c.req.json<{ token?: unknown; emails?: unknown }>().catch(() => null)
  if (typeof body?.token !== 'string' || typeof body?.emails !== 'string') {
    return c.json({ error: 'bad_request', message: 'Send token and emails.' }, 400)
  }
  try {
    const teamDomain = await runSetup(d1Settings(c.env.DB), new URL(c.req.url).hostname, body.token, body.emails)
    return c.json({ ok: true, teamDomain })
  } catch (e) {
    if (e instanceof SetupError) return c.json({ error: e.code, message: e.message, detail: e.detail }, 400)
    throw e
  }
})

// ---------- Public shared links ----------
// The only routes open to anyone: ciphertext of one shared note, and the page that decrypts it.
// The key is in the link's #fragment, which never reaches this server.

app.get('/api/share/:id', async (c) => {
  c.header('Cache-Control', 'no-store')
  const id = c.req.param('id')
  const shared = SHARE_ID_RE.test(id) ? await publicShare(c.env.DB, id).catch(() => null) : null
  return shared ? c.json(shared) : c.json({ error: 'not_found' }, 404)
})

app.get('/s/:id', (c) => {
  const nonce = crypto.randomUUID().replace(/-/g, '')
  return c.body(sharePage(nonce), 200, sharePageHeaders(nonce))
})

app.route('/api/v1', api)
app.route('/api', api)
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal' }, 500)
})

// ---------- helpers ----------

function getNote(db: D1Database, user: string, id: string) {
  return db
    .prepare(
      `SELECT id, ciphertext, iv, pinned, archived, trashed_at, position, version, created_at, updated_at
       FROM notes WHERE user_id = ? AND id = ?`,
    )
    .bind(user, id)
    .first<NoteRow>()
}

function isValidNoteBody(b: unknown): b is Omit<PutNoteBody, 'baseVersion'> & { baseVersion?: number } {
  if (!b || typeof b !== 'object') return false
  const n = b as Record<string, unknown>
  return (
    isB64(n.ciphertext, MAX_CIPHERTEXT) &&
    isB64(n.iv, 24) &&
    typeof n.pinned === 'boolean' &&
    typeof n.archived === 'boolean' &&
    typeof n.position === 'number' &&
    Number.isFinite(n.position) &&
    (n.trashedAt === null || (typeof n.trashedAt === 'number' && Number.isFinite(n.trashedAt)))
  )
}

function isB64(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && B64_RE.test(v)
}

export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    // Every 5 minutes: reminders that are due. Without the tables (migration not applied) there is nothing to send.
    if (event.cron === PUSH_CRON) {
      await sendDuePushes(env.DB, Date.now()).catch((e) => console.error('push', e))
      return
    }
    await env.DB.prepare('DELETE FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?')
      .bind(Date.now() - TRASH_TTL_MS)
      .run()
    await purgeShares(env.DB).catch(() => {}) // the shares table may not exist yet
    await runScheduledBackups(env)
  },
} satisfies ExportedHandler<Env>
