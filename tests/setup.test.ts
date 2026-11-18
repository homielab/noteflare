import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSettingsCache, isUnset, parseEmails, resolveAccess, runSetup, SetupError, type SettingsStore } from '../worker/setup'

function memoryStore(initial: Record<string, string> = {}): SettingsStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)!]))
    },
    async set(values) {
      for (const [k, v] of Object.entries(values)) data.set(k, v)
    },
    async delete(key) {
      data.delete(key)
    },
  }
}

const HOST = 'noteflare.me.workers.dev'
const TOKEN = 'x'.repeat(40)
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })
const fail = (status: number) => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'nope' }], result: null }), { status })

interface Call {
  method: string
  path: string
  body: any
}

/** A fake Cloudflare API: one account with an unrelated database and NoteFlare's own. */
function fakeCloudflare(store: ReturnType<typeof memoryStore>, opts: { apps?: unknown[]; ownCode?: string | null; accounts?: number } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace('https://api.cloudflare.com/client/v4', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    if (path.startsWith('/accounts?')) return opts.accounts === 403 ? fail(403) : ok([{ id: 'acc' }])
    if (path.startsWith('/accounts/acc/d1/database?')) return ok([{ uuid: 'other', name: 'blog' }, { uuid: 'own', name: 'noteflare' }])
    if (path === '/accounts/acc/d1/database/own/query') {
      const code = opts.ownCode === undefined ? store.data.get('setup_code') : opts.ownCode
      return ok([{ results: code ? [{ value: code }] : [] }])
    }
    if (path === '/accounts/acc/d1/database/other/query') return fail(400)
    if (path === '/accounts/acc/access/organizations') return ok({ auth_domain: 'myteam.cloudflareaccess.com' })
    if (path === '/accounts/acc/access/identity_providers') return method === 'GET' ? ok([]) : ok({ id: 'otp' })
    if (path.startsWith('/accounts/acc/access/apps')) return method === 'GET' ? ok(opts.apps ?? []) : ok({ aud: 'new-aud' })
    throw new Error(`unexpected ${method} ${path}`)
  })
  return calls
}

beforeEach(() => clearSettingsCache())
afterEach(() => vi.unstubAllGlobals())

describe('resolveAccess', () => {
  const base = { ACCESS_TEAM_DOMAIN: 'todo', ACCESS_AUD: 'todo', ALLOWED_EMAILS: '' }

  it('prefers values set in wrangler.jsonc', async () => {
    const env = { ACCESS_TEAM_DOMAIN: 'https://a.cloudflareaccess.com', ACCESS_AUD: 'aud', ALLOWED_EMAILS: 'me@x.com' }
    const store = memoryStore({ access_team_domain: 'https://b.cloudflareaccess.com', access_aud: 'other' })
    expect(await resolveAccess(env, store)).toMatchObject(env)
  })

  it('uses the saved setup when the variables are placeholders', async () => {
    const store = memoryStore({ access_team_domain: 'https://t.cloudflareaccess.com', access_aud: 'aud', allowed_emails: 'me@x.com' })
    expect(await resolveAccess(base, store)).toMatchObject({ ACCESS_TEAM_DOMAIN: 'https://t.cloudflareaccess.com', ACCESS_AUD: 'aud', ALLOWED_EMAILS: 'me@x.com' })
  })

  it('keeps ALLOWED_EMAILS from wrangler.jsonc over the saved ones', async () => {
    const store = memoryStore({ access_team_domain: 'https://t.cloudflareaccess.com', access_aud: 'aud', allowed_emails: 'me@x.com' })
    expect((await resolveAccess({ ...base, ALLOWED_EMAILS: 'boss@x.com' }, store)).ALLOWED_EMAILS).toBe('boss@x.com')
  })

  it('reports nothing set up as empty values, never "todo"', async () => {
    expect(await resolveAccess({ ...base, ALLOWED_EMAILS: 'todo' }, memoryStore())).toMatchObject({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ALLOWED_EMAILS: '' })
  })

  it('treats empty and todo as unset', () => {
    expect([isUnset(''), isUnset(' TODO '), isUnset(undefined), isUnset('https://t.cloudflareaccess.com')]).toEqual([true, true, true, false])
  })
})

describe('parseEmails', () => {
  it('accepts emails and @domains', () => {
    expect(parseEmails(' Me@X.com, @team.org me@x.com ')).toEqual(['me@x.com', '@team.org'])
  })
  it('rejects anything else', () => {
    expect(parseEmails('')).toBeNull()
    expect(parseEmails('me@x.com, everyone')).toBeNull()
  })
})

describe('runSetup', () => {
  it('creates the login for this host and saves it', async () => {
    const store = memoryStore()
    const calls = fakeCloudflare(store)
    expect(await runSetup(store, HOST, TOKEN, 'me@x.com, @team.org')).toBe('https://myteam.cloudflareaccess.com')

    expect(Object.fromEntries(store.data)).toEqual({
      access_team_domain: 'https://myteam.cloudflareaccess.com',
      access_aud: 'new-aud',
      allowed_emails: 'me@x.com,@team.org',
    })
    const app = calls.find((c) => c.method === 'POST' && c.path === '/accounts/acc/access/apps')!
    expect(app.body).toMatchObject({ type: 'self_hosted', domain: HOST })
    expect(app.body.policies[0]).toMatchObject({
      decision: 'allow',
      include: [{ email: { email: 'me@x.com' } }, { email_domain: { domain: 'team.org' } }],
    })
    expect(calls.some((c) => c.method === 'POST' && c.body?.type === 'onetimepin')).toBe(true)
  })

  it('refuses a token from another account and saves nothing', async () => {
    const store = memoryStore()
    const calls = fakeCloudflare(store, { ownCode: 'someone-elses-code' })
    await expect(runSetup(store, HOST, TOKEN, 'me@x.com')).rejects.toMatchObject({ code: 'not_owner' })
    expect(store.data.has('access_aud')).toBe(false)
    expect(calls.some((c) => c.method === 'POST' && c.path.includes('/access/'))).toBe(false)
  })

  it('never sends the setup code to Cloudflare', async () => {
    const store = memoryStore()
    const calls = fakeCloudflare(store, { ownCode: null })
    await expect(runSetup(store, HOST, TOKEN, 'me@x.com')).rejects.toBeInstanceOf(SetupError)
    const code = store.data.get('setup_code')!
    expect(code).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(calls)).not.toContain(code)
  })

  it('reuses an Access application that already covers the host', async () => {
    const store = memoryStore()
    const calls = fakeCloudflare(store, { apps: [{ aud: 'existing-aud', domain: HOST }] })
    await runSetup(store, HOST, TOKEN, 'me@x.com')
    expect(store.data.get('access_aud')).toBe('existing-aud')
    expect(calls.some((c) => c.method === 'POST' && c.path === '/accounts/acc/access/apps')).toBe(false)
  })

  it('says so when Cloudflare rejects the token', async () => {
    const store = memoryStore()
    fakeCloudflare(store, { accounts: 403 })
    await expect(runSetup(store, HOST, TOKEN, 'me@x.com')).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('says the migrations are missing when the settings table does not exist', async () => {
    const store = memoryStore()
    store.set = async () => {
      throw new Error('D1_ERROR: no such table: settings: SQLITE_ERROR')
    }
    const calls = fakeCloudflare(store)
    await expect(runSetup(store, HOST, TOKEN, 'me@x.com')).rejects.toMatchObject({ code: 'no_database' })
    expect(calls).toHaveLength(0)
  })

  it('reports other Cloudflare failures as a setup error', async () => {
    const store = memoryStore()
    vi.stubGlobal('fetch', async () => fail(500))
    await expect(runSetup(store, HOST, TOKEN, 'me@x.com')).rejects.toMatchObject({ code: 'cloudflare', detail: 'nope' })
  })

  it('checks the input before calling Cloudflare', async () => {
    const store = memoryStore()
    const calls = fakeCloudflare(store)
    await expect(runSetup(store, HOST, TOKEN, 'not an email')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(runSetup(store, HOST, 'short', 'me@x.com')).rejects.toMatchObject({ code: 'invalid_token' })
    expect(calls).toHaveLength(0)
  })
})
