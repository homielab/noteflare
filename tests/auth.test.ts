import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { getAccessUser, isAccessMissing, isAllowedEmail } from '../worker/auth'

const TEAM = 'https://demo.cloudflareaccess.com'
const AUD = 'aud-tag-123'
let sign: (claims: Record<string, unknown>, aud?: string, iss?: string) => Promise<string>

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  vi.stubGlobal('fetch', async (url: string | URL) => {
    expect(String(url)).toBe(`${TEAM}/cdn-cgi/access/certs`)
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
  })
  sign = (claims, aud = AUD, iss = TEAM) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience(aud)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey)
})
afterAll(() => vi.unstubAllGlobals())

const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }
const reqWith = (token?: string) =>
  new Request('https://notes.example.com/api/me', { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} })

describe('isAccessMissing', () => {
  it('is true when the Access variables are unset or the request has no Access token', () => {
    expect(isAccessMissing(reqWith('any'), { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' })).toBe(true)
    expect(isAccessMissing(reqWith(), env)).toBe(true)
  })
  it('is false when a token is present, even an invalid one', () => {
    expect(isAccessMissing(reqWith('not-a-jwt'), env)).toBe(false)
    const r = new Request('https://x/api/me', { headers: { Cookie: 'CF_Authorization=stale' } })
    expect(isAccessMissing(r, env)).toBe(false)
  })
})

describe('getAccessUser', () => {
  it('accepts a valid Access JWT', async () => {
    expect(await getAccessUser(reqWith(await sign({ email: 'Minh@Example.com' })), env)).toBe('minh@example.com')
  })
  it('accepts the CF_Authorization cookie', async () => {
    const t = await sign({ email: 'a@b.c' })
    const r = new Request('https://x/api/me', { headers: { Cookie: `foo=1; CF_Authorization=${t}` } })
    expect(await getAccessUser(r, env)).toBe('a@b.c')
  })
  it('rejects missing token, wrong audience, wrong issuer, tampered token', async () => {
    expect(await getAccessUser(reqWith(), env)).toBeNull()
    expect(await getAccessUser(reqWith(await sign({ email: 'a@b.c' }, 'other-aud')), env)).toBeNull()
    expect(await getAccessUser(reqWith(await sign({ email: 'a@b.c' }, AUD, 'https://evil.cloudflareaccess.com')), env)).toBeNull()
    const t = await sign({ email: 'a@b.c' })
    expect(await getAccessUser(reqWith(t.slice(0, -4) + 'AAAA'), env)).toBeNull()
  })
  it('ignores DEV_USER_EMAIL once Access is configured', async () => {
    expect(await getAccessUser(reqWith(), { ...env, DEV_USER_EMAIL: 'dev@x.y' })).toBeNull()
  })
  it('honors DEV_USER_EMAIL only on localhost, so a mistaken production setting stays locked', async () => {
    const dev = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: 'Dev@x.y' }
    expect(await getAccessUser(new Request('http://localhost:8787/api/me'), dev)).toBe('dev@x.y')
    expect(await getAccessUser(new Request('http://127.0.0.1:5173/api/me'), dev)).toBe('dev@x.y')
    expect(await getAccessUser(reqWith(), dev)).toBeNull()
    expect(await getAccessUser(new Request('https://noteflare.me.workers.dev/api/me'), dev)).toBeNull()
  })
  it('applies ALLOWED_EMAILS on top of a valid Access JWT', async () => {
    const t = await sign({ email: 'Minh@Example.com' })
    expect(await getAccessUser(reqWith(t), { ...env, ALLOWED_EMAILS: 'someone@else.com' })).toBeNull()
    expect(await getAccessUser(reqWith(t), { ...env, ALLOWED_EMAILS: 'someone@else.com, minh@example.com' })).toBe('minh@example.com')
    expect(await getAccessUser(reqWith(t), { ...env, ALLOWED_EMAILS: '@example.com' })).toBe('minh@example.com')
  })
})

describe('isAllowedEmail', () => {
  it('allows everyone when empty and matches emails or @domains otherwise', () => {
    expect(isAllowedEmail('a@b.c', {})).toBe(true)
    expect(isAllowedEmail('a@b.c', { ALLOWED_EMAILS: ' ' })).toBe(true)
    expect(isAllowedEmail('A@B.C', { ALLOWED_EMAILS: 'a@b.c' })).toBe(true)
    expect(isAllowedEmail('x@b.c', { ALLOWED_EMAILS: '@b.c x@y.z' })).toBe(true)
    expect(isAllowedEmail('x@evilb.c', { ALLOWED_EMAILS: '@b.c' })).toBe(false)
    expect(isAllowedEmail('b.c@evil.com', { ALLOWED_EMAILS: '@b.c' })).toBe(false)
  })
})
