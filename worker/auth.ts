import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  /** Only set in .dev.vars for local development. Ignored unless the request comes to localhost. */
  DEV_USER_EMAIL?: string
  /**
   * Optional allowlist checked by the Worker itself, on top of the Access policy:
   * comma- or space-separated emails and "@domain" entries. Empty = whoever Access lets in.
   */
  ALLOWED_EMAILS?: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True when ALLOWED_EMAILS is empty or lists this email (or its "@domain"). */
export function isAllowedEmail(email: string, env: Pick<AccessEnv, 'ALLOWED_EMAILS'>): boolean {
  const list = (env.ALLOWED_EMAILS ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!list.length) return true
  const e = email.toLowerCase()
  const domain = e.slice(e.lastIndexOf('@'))
  return list.includes(e) || list.includes(domain)
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
    jwksCache.set(teamDomain, jwks)
  }
  return jwks
}

/**
 * Verify the JWT Cloudflare Access attaches to each request.
 * Headers are never trusted blindly: signature, issuer and audience are checked.
 * Returns the user's email, or null if the token isn't valid.
 */
export async function getAccessUser(req: Request, env: AccessEnv): Promise<string | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '')

  if (!teamDomain || !env.ACCESS_AUD) {
    // Dev mode: only when Access is NOT configured, DEV_USER_EMAIL is set, AND the request
    // is to localhost. A deployment with DEV_USER_EMAIL set by mistake stays locked (401).
    if (!env.DEV_USER_EMAIL || !LOCAL_HOSTS.has(new URL(req.url).hostname)) return null
    return env.DEV_USER_EMAIL.toLowerCase()
  }

  const token =
    req.headers.get('Cf-Access-Jwt-Assertion') ??
    getCookie(req.headers.get('Cookie'), 'CF_Authorization')
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
    })
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null
    return email && isAllowedEmail(email, env) ? email : null
  } catch {
    return null
  }
}

/**
 * True when a request can't have come through Cloudflare Access: the Access variables
 * are unset, or the request carries no Access token at all. Access adds a token to every
 * request it lets through, so a missing one means no Access application covers this
 * hostname yet. Only used to pick the message a locked-out visitor sees.
 */
export function isAccessMissing(req: Request, env: AccessEnv): boolean {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return true
  return !req.headers.get('Cf-Access-Jwt-Assertion') && !getCookie(req.headers.get('Cookie'), 'CF_Authorization')
}

function getCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}
