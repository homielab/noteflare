import { TOKEN_PREFIX, type ApiToken, type TokenScope } from '../shared/types'

/** Don't write `last_used_at` on every request: once per window is enough and saves D1 writes. */
const LAST_USED_RESOLUTION_MS = 10 * 60 * 1000

interface TokenRow {
  id: string
  user_id: string
  name: string
  prefix: string
  scope: TokenScope
  created_at: number
  last_used_at: number | null
  expires_at: number | null
}

/** 32 random bytes, base64url — 256 bits, so brute force is not a concern. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return TOKEN_PREFIX + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const tokenPrefix = (token: string) => token.slice(0, TOKEN_PREFIX.length + 6)

/** Look up a bearer token. Returns null if unknown, malformed or expired. */
export async function verifyToken(
  db: D1Database,
  token: string,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<{ user: string; scope: TokenScope; id: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 40 || token.length > 64) return null
  const row = await db
    .prepare('SELECT id, user_id, scope, last_used_at, expires_at FROM api_tokens WHERE hash = ?')
    .bind(await hashToken(token))
    .first<Pick<TokenRow, 'id' | 'user_id' | 'scope' | 'last_used_at' | 'expires_at'>>()
  const now = Date.now()
  if (!row || (row.expires_at !== null && row.expires_at <= now)) return null

  if (!row.last_used_at || now - row.last_used_at > LAST_USED_RESOLUTION_MS) {
    const write = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()
    ctx ? ctx.waitUntil(write) : await write
  }
  return { user: row.user_id, scope: row.scope, id: row.id }
}

export function toApiToken(r: TokenRow): ApiToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }
}

export type { TokenRow }
