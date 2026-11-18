import type { AccessEnv } from './auth'

/**
 * In-app setup of Cloudflare Access.
 *
 * A fresh deployment has no Access login yet. Instead of creating it by hand and editing
 * wrangler.jsonc, the owner pastes a Cloudflare API token and NoteFlare creates the Access
 * application for its own hostname, then saves the team domain and AUD tag in D1.
 *
 * The setup page is reachable by anyone until it is done, so the token must prove it belongs
 * to the account this deployment runs in: NoteFlare keeps a random code in its own D1 and
 * accepts the token only if the code can be read back through it. The code never leaves the
 * Worker, so a token for another account can't pass. The token is used once, never stored.
 */

/** Key/value settings kept in D1 (table `settings`). An interface so tests can use a Map. */
export interface SettingsStore {
  get(keys: string[]): Promise<Record<string, string>>
  set(values: Record<string, string>): Promise<void>
  delete(key: string): Promise<void>
}

export function d1Settings(db: D1Database): SettingsStore {
  return {
    async get(keys) {
      try {
        const { results } = await db
          .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`)
          .bind(...keys)
          .all<{ key: string; value: string }>()
        return Object.fromEntries(results.map((r) => [r.key, r.value]))
      } catch (e) {
        // `bun run deploy` applies migrations after the new code is live: no table yet = nothing saved.
        if (String(e).includes('no such table')) return {}
        throw e
      }
    },
    async set(values) {
      const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      await db.batch(Object.entries(values).map(([k, v]) => stmt.bind(k, v)))
    },
    async delete(key) {
      await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run()
    },
  }
}

const K = { team: 'access_team_domain', aud: 'access_aud', emails: 'allowed_emails', code: 'setup_code' } as const

/** "todo" is the placeholder the Deploy to Cloudflare form needs, because it refuses empty values. */
export const isUnset = (v?: string) => !v || !v.trim() || v.trim().toLowerCase() === 'todo'

let saved: { at: number; value: Record<string, string> } | null = null
const SAVED_TTL_MS = 10_000

/** Forget the cached settings (after setup, and between tests). */
export function clearSettingsCache() {
  saved = null
}

/**
 * The Access settings in effect. Values set in wrangler.jsonc win; otherwise the ones the
 * in-app setup saved. Unset values come back as '' (no Access: locked, or dev mode on localhost).
 */
export async function resolveAccess<E extends AccessEnv>(env: E, store: SettingsStore): Promise<E> {
  const emails = isUnset(env.ALLOWED_EMAILS) ? '' : env.ALLOWED_EMAILS!
  if (!isUnset(env.ACCESS_TEAM_DOMAIN) && !isUnset(env.ACCESS_AUD)) return { ...env, ALLOWED_EMAILS: emails }
  // A finished setup never changes, so it is cached for good; "not set up yet" only briefly.
  if (!saved || (!saved.value[K.aud] && Date.now() - saved.at > SAVED_TTL_MS)) {
    saved = { at: Date.now(), value: await store.get([K.team, K.aud, K.emails]) }
  }
  const s = saved.value
  if (!s[K.team] || !s[K.aud]) return { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ALLOWED_EMAILS: emails }
  return { ...env, ACCESS_TEAM_DOMAIN: s[K.team], ACCESS_AUD: s[K.aud], ALLOWED_EMAILS: emails || s[K.emails] || '' }
}

/** True when nobody can sign in yet and the in-app setup may run. */
export const needsSetup = (resolved: AccessEnv) => !resolved.ACCESS_TEAM_DOMAIN || !resolved.ACCESS_AUD

/** Opens the dashboard's token form with the permissions setup needs already selected. */
export const TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(
    JSON.stringify([
      { key: 'access', type: 'edit' },
      { key: 'access_acct', type: 'edit' },
      { key: 'd1', type: 'read' },
      { key: 'account_settings', type: 'read' },
    ]),
  ) +
  '&accountId=*&zoneId=all&name=' +
  encodeURIComponent('NoteFlare setup')

export type SetupErrorCode = 'bad_request' | 'invalid_token' | 'not_owner' | 'zero_trust' | 'cloudflare' | 'no_database'

export class SetupError extends Error {
  constructor(
    public code: SetupErrorCode,
    message: string,
    /** Cloudflare's own error text, when it refused a step. */
    public detail?: string,
  ) {
    super(message)
  }
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
const DOMAIN_RE = /^@[^\s@,]+\.[^\s@,]+$/

/** "a@x.com, @y.org" → ['a@x.com', '@y.org']; null when an entry is neither an email nor "@domain". */
export function parseEmails(input: string): string[] | null {
  const list = [...new Set(input.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))]
  if (!list.length || list.length > 20) return null
  return list.every((e) => EMAIL_RE.test(e) || DOMAIN_RE.test(e)) ? list : null
}

const CF_API = 'https://api.cloudflare.com/client/v4'
const MAX_DB_LOOKUPS = 50

interface CfEnvelope<T> {
  success: boolean
  errors?: { code: number; message: string }[]
  result: T
}

class CfError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function cloudflare(token: string) {
  return async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(CF_API + path, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null
    if (!res.ok || !data?.success) {
      throw new CfError(res.status, data?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`)
    }
    return data.result
  }
}

interface AccessApp {
  aud: string
  domain?: string
  self_hosted_domains?: string[]
  destinations?: { type?: string; uri?: string }[]
}

const coversHost = (app: AccessApp, host: string) =>
  app.domain === host || !!app.self_hosted_domains?.includes(host) || !!app.destinations?.some((d) => d.uri === host)

/** Access policy rules for a list of emails and "@domain" entries. */
const includeRules = (emails: string[]) =>
  emails.map((e) => (e.startsWith('@') ? { email_domain: { domain: e.slice(1) } } : { email: { email: e } }))

/** The random code a token must be able to read from this deployment's D1. */
async function setupCode(store: SettingsStore): Promise<string> {
  const existing = (await store.get([K.code]))[K.code]
  if (existing) return existing
  const code = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
  try {
    await store.set({ [K.code]: code })
  } catch (e) {
    // The deploy went live but its migrations were never applied.
    if (String(e).includes('no such table')) {
      throw new SetupError(
        'no_database',
        "NoteFlare's database has no tables yet, so the last deploy didn't finish. Run bun run db:migrate:remote, or deploy again, then try again.",
      )
    }
    throw e
  }
  return code
}

/** The account whose D1 holds our code, i.e. the account this deployment runs in. */
async function findOwnAccount(cf: ReturnType<typeof cloudflare>, code: string): Promise<string | null> {
  let accounts: { id: string }[]
  try {
    accounts = await cf<{ id: string }[]>('/accounts?per_page=50')
  } catch (e) {
    if (e instanceof CfError && (e.status === 401 || e.status === 403)) {
      throw new SetupError('invalid_token', 'Cloudflare did not accept this token. Copy it again, in full.')
    }
    throw new SetupError(
      'cloudflare',
      'Cloudflare refused a step. Check the token has the permissions the link selects.',
      e instanceof Error ? e.message : String(e),
    )
  }
  let lookups = 0
  for (const { id } of accounts) {
    let dbs: { uuid: string; name: string }[]
    try {
      dbs = await cf<{ uuid: string; name: string }[]>(`/accounts/${id}/d1/database?per_page=100`)
    } catch {
      continue // no D1 permission on this account
    }
    dbs.sort((a, b) => Number(b.name.includes('noteflare')) - Number(a.name.includes('noteflare')))
    for (const db of dbs) {
      if (++lookups > MAX_DB_LOOKUPS) return null
      try {
        const out = await cf<{ results: { value: string }[] }[]>(`/accounts/${id}/d1/database/${db.uuid}/query`, {
          method: 'POST',
          body: { sql: 'SELECT value FROM settings WHERE key = ?', params: [K.code] },
        })
        if (out[0]?.results?.[0]?.value === code) return id
      } catch {
        // another database without a settings table
      }
    }
  }
  return null
}

/** The Zero Trust team domain, creating the Zero Trust organization on a first use. */
async function teamDomain(cf: ReturnType<typeof cloudflare>, account: string): Promise<string> {
  try {
    const org = await cf<{ auth_domain?: string } | null>(`/accounts/${account}/access/organizations`)
    if (org?.auth_domain) return org.auth_domain
  } catch {
    // none yet
  }
  try {
    const org = await cf<{ auth_domain: string }>(`/accounts/${account}/access/organizations`, {
      method: 'POST',
      body: { name: 'NoteFlare' },
    })
    return org.auth_domain
  } catch (e) {
    throw new SetupError(
      'zero_trust',
      'Cloudflare could not turn on Zero Trust for this account. Open Zero Trust in the Cloudflare dashboard once, choose a team name and the Free plan, then try again.',
      e instanceof Error ? e.message : String(e),
    )
  }
}

/**
 * Create the Access login for `host`, allowing `emails`, and save it. Returns the team domain.
 * An Access application that already covers the host is reused as it is.
 */
export async function runSetup(store: SettingsStore, host: string, token: string, emailsInput: string): Promise<string> {
  const emails = parseEmails(emailsInput)
  if (!emails) throw new SetupError('bad_request', 'Enter your email address, or several separated by commas.')
  if (!/^\S{20,200}$/.test(token.trim())) throw new SetupError('invalid_token', 'Paste the API token Cloudflare showed you.')

  const cf = cloudflare(token.trim())
  const account = await findOwnAccount(cf, await setupCode(store))
  if (!account) {
    throw new SetupError(
      'not_owner',
      "This token can't see this NoteFlare's database. Create it in the Cloudflare account NoteFlare is deployed to, with the permissions the link selects.",
    )
  }

  try {
    const domain = await teamDomain(cf, account)

    // Login with a code sent by email, so nothing else has to be configured.
    const idps = await cf<{ type: string }[]>(`/accounts/${account}/access/identity_providers`)
    if (!idps.some((p) => p.type === 'onetimepin')) {
      await cf(`/accounts/${account}/access/identity_providers`, {
        method: 'POST',
        body: { name: 'One-time PIN', type: 'onetimepin', config: {} },
      })
    }

    const apps = await cf<AccessApp[]>(`/accounts/${account}/access/apps?per_page=1000`)
    let app = apps.find((a) => coversHost(a, host))
    if (!app) {
      app = await cf<AccessApp>(`/accounts/${account}/access/apps`, {
        method: 'POST',
        body: {
          name: 'NoteFlare',
          type: 'self_hosted',
          domain: host,
          destinations: [{ type: 'public', uri: host }],
          // A notes app is opened every day; a month between logins instead of a day.
          session_duration: '720h',
          app_launcher_visible: false,
          policies: [{ name: 'NoteFlare owner', decision: 'allow', include: includeRules(emails), precedence: 1 }],
        },
      })
      // Browsers fetch the install manifest and icons without the login cookie; they hold
      // nothing private. Optional: installing still works on most browsers without it.
      await cf(`/accounts/${account}/access/apps`, {
        method: 'POST',
        body: {
          name: 'NoteFlare app icons',
          type: 'self_hosted',
          domain: `${host}/manifest.webmanifest`,
          destinations: [
            { type: 'public', uri: `${host}/manifest.webmanifest` },
            { type: 'public', uri: `${host}/icons` },
          ],
          app_launcher_visible: false,
          policies: [{ name: 'Public', decision: 'bypass', include: [{ everyone: {} }], precedence: 1 }],
        },
      }).catch(() => {})
      // Shared note links: the page and its ciphertext endpoint are public, the key is in the link.
      await cf(`/accounts/${account}/access/apps`, {
        method: 'POST',
        body: {
          name: 'NoteFlare shared links',
          type: 'self_hosted',
          domain: `${host}/s`,
          destinations: [
            { type: 'public', uri: `${host}/s` },
            { type: 'public', uri: `${host}/api/share` },
          ],
          app_launcher_visible: false,
          policies: [{ name: 'Public', decision: 'bypass', include: [{ everyone: {} }], precedence: 1 }],
        },
      }).catch(() => {})
    }

    await store.set({ [K.team]: `https://${domain}`, [K.aud]: app.aud, [K.emails]: emails.join(',') })
    await store.delete(K.code)
    clearSettingsCache()
    return `https://${domain}`
  } catch (e) {
    if (e instanceof SetupError) throw e
    throw new SetupError(
      'cloudflare',
      'Cloudflare refused a step. Check the token has the permissions the link selects.',
      e instanceof Error ? e.message : String(e),
    )
  }
}
