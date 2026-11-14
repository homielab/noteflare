import { Hono, type Context, type Next } from 'hono'
import { cors } from 'hono/cors'
import { getAccessUser, isAccessMissing, isAllowedEmail, type AccessEnv } from './auth'
import { generateToken, hashToken, toApiToken, tokenPrefix, verifyToken, type TokenRow } from './tokens'
import { openApiSpec } from './openapi'
import { versionInfo, type UpdateEnv } from './updates'
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_NOTES,
  MAX_ATTACHMENT_BYTES,
  MAX_TOKENS_PER_USER,
  type BatchNoteItem,
  type BatchResult,
  type CreateTokenBody,
  type CreateTokenResponse,
  type EncryptedNote,
  type MeResponse,
  type PutNoteBody,
  type TokenScope,
  type VaultRecord,
} from '../shared/types'

interface Env extends AccessEnv, UpdateEnv {
  DB: D1Database
  ASSETS: Fetcher
  /** Optional R2 bucket for encrypted image attachments. Without it the feature is off. */
  ATTACHMENTS?: R2Bucket
}

type Vars = { user: string; scope: TokenScope; via: 'session' | 'token' }
type Ctx = Context<{ Bindings: Env; Variables: Vars }>

const MAX_CIPHERTEXT = 512 * 1024 // ~384 KB plaintext / note
const ID_RE = /^[0-9a-f-]{36}$/i
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
/** Encryption adds an IV, an auth tag and the hidden file type to each attachment. */
const MAX_BLOB_BYTES = MAX_ATTACHMENT_BYTES + 512
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
  if (isV1(c)) {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')
    if (!m) return unauthorized(c, 'unauthorized', 'Send a NoteFlare API token: Authorization: Bearer nf_…')
    const t = await verifyToken(c.env.DB, m[1], c.executionCtx)
    // A token stops working when its owner is removed from ALLOWED_EMAILS.
    if (!t || !isAllowedEmail(t.user, c.env)) return unauthorized(c, 'invalid_token', 'This token is unknown, revoked or expired.')
    c.set('user', t.user)
    c.set('scope', t.scope)
    c.set('via', 'token')
  } else {
    const user = await getAccessUser(c.req.raw, c.env)
    if (!user) {
      // Tell a first-time deployer apart from an expired session (see isAccessMissing).
      const reason = isAccessMissing(c.req.raw, c.env) ? { reason: 'access_not_set_up' } : {}
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
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
})

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
api.get('/version', async (c) => c.json(await versionInfo(c.env, { force: c.req.query('refresh') === '1' })))

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
    .first<{ kdf: string; wrapped_dek: string; recovery_dek: string; version: number }>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json<VaultRecord>({
    kdf: JSON.parse(row.kdf),
    wrappedDek: row.wrapped_dek,
    recoveryDek: row.recovery_dek,
    version: row.version,
  })
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

  const row = await getNote(c.env.DB, user, id)
  if (!res.meta.changes) {
    // Conflict: return the current server copy so the client can resolve it.
    return row ? c.json({ error: 'conflict', current: toNote(row) }, 409) : c.json({ error: 'not_found' }, 404)
  }
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
  return c.json(out)
})

/** Delete forever (only notes already in the trash). */
api.delete('/notes/:id', needWrite, async (c) => {
  const res = await c.env.DB.prepare(
    'DELETE FROM notes WHERE user_id = ? AND id = ? AND trashed_at IS NOT NULL',
  )
    .bind(c.get('user'), c.req.param('id') ?? '')
    .run()
  return res.meta.changes ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

// ---------- API tokens (web app only) ----------

// ---------- Attachments ----------
// Encrypted images in R2, one object per attachment under the owner's own prefix.
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

app.route('/api/v1', api)
app.route('/api', api)
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal' }, 500)
})

// ---------- helpers ----------

interface NoteRow {
  id: string
  ciphertext: string
  iv: string
  pinned: number
  archived: number
  trashed_at: number | null
  position: number
  version: number
  created_at: number
  updated_at: number
}

function getNote(db: D1Database, user: string, id: string) {
  return db
    .prepare(
      `SELECT id, ciphertext, iv, pinned, archived, trashed_at, position, version, created_at, updated_at
       FROM notes WHERE user_id = ? AND id = ?`,
    )
    .bind(user, id)
    .first<NoteRow>()
}

function toNote(r: NoteRow): EncryptedNote {
  return {
    id: r.id,
    ciphertext: r.ciphertext,
    iv: r.iv,
    pinned: !!r.pinned,
    archived: !!r.archived,
    trashedAt: r.trashed_at,
    position: r.position,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
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
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?')
      .bind(Date.now() - TRASH_TTL_MS)
      .run()
  },
} satisfies ExportedHandler<Env>
