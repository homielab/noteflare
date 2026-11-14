import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { compareVersions, isNewer, parseChangelog, parseVersion, releasesBetween } from '../shared/release'
import { APP_VERSION } from '../shared/version'
import { resetUpdateCache, updateRepo, versionInfo } from '../worker/updates'

describe('versions', () => {
  it('parses and compares semantic versions', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: '' })
    expect(parseVersion('1.2')).toBeNull()
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0-beta.2')).toBe(true)
    expect(isNewer('1.0.0-beta.10', '1.0.0-beta.2')).toBe(true)
    expect(isNewer('1.0.0-beta', '1.0.0-alpha.5')).toBe(true)
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(isNewer('garbage', '0.1.0')).toBe(false)
  })
})

describe('changelog', () => {
  const md = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-12-01

### Added
- Thing

## [0.1.1] - 2026-11-22
- Fix

## [0.1.0] - 2026-11-17
First.

[Unreleased]: https://example.com
[0.1.0]: https://example.com/v0.1.0
`
  it('splits releases and drops link definitions', () => {
    const r = parseChangelog(md)
    expect(r.map((x) => x.version)).toEqual(['Unreleased', '0.2.0', '0.1.1', '0.1.0'])
    expect(r[1]).toEqual({ version: '0.2.0', date: '2026-12-01', body: '### Added\n- Thing' })
    expect(r[3].body).toBe('First.')
    expect(r[0].body).toBe('')
  })
  it('picks the releases between two versions', () => {
    expect(releasesBetween(parseChangelog(md), '0.1.0', '0.2.0').map((x) => x.version)).toEqual(['0.2.0', '0.1.1'])
  })
  it('the real CHANGELOG has an entry for the current version', () => {
    const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'))
    expect(releases.some((r) => r.version === APP_VERSION)).toBe(true)
  })
})

describe('update check', () => {
  beforeEach(() => resetUpdateCache())

  const github = (tag: string, calls: string[] = []) =>
    (async (url: string) => {
      calls.push(String(url))
      return new Response(
        JSON.stringify({ tag_name: tag, name: `NoteFlare ${tag}`, html_url: `https://github.com/homielab/noteflare/releases/tag/${tag}`, published_at: '2026-12-01T00:00:00Z', body: '- New' }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

  it('reports a newer release', async () => {
    const info = await versionInfo({}, { fetcher: github('v99.0.0') })
    expect(info).toMatchObject({ version: APP_VERSION, checkEnabled: true, updateAvailable: true })
    expect(info.latest).toMatchObject({ version: '99.0.0', notes: '- New' })
  })

  it('says up to date when the release is this version', async () => {
    const info = await versionInfo({}, { fetcher: github(`v${APP_VERSION}`) })
    expect(info.updateAvailable).toBe(false)
  })

  it('caches the answer and limits forced refreshes', async () => {
    const calls: string[] = []
    const fetcher = github('v99.0.0', calls)
    await versionInfo({}, { fetcher, now: 0 })
    await versionInfo({}, { fetcher, now: 1000 })
    await versionInfo({}, { fetcher, now: 30_000, force: true })
    expect(calls).toHaveLength(1)
    await versionInfo({}, { fetcher, now: 61_000, force: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe('https://api.github.com/repos/homielab/noteflare/releases/latest')
  })

  it('can point at a fork or be turned off', async () => {
    expect(updateRepo({ UPDATE_CHECK_REPO: 'me/my-fork' })).toBe('me/my-fork')
    expect(updateRepo({ UPDATE_CHECK_REPO: 'off' })).toBeNull()
    expect(updateRepo({ UPDATE_CHECK_REPO: '../evil' })).toBeNull()
    const info = await versionInfo({ UPDATE_CHECK_REPO: 'off' }, { fetcher: github('v99.0.0') })
    expect(info).toMatchObject({ checkEnabled: false, latest: null, updateAvailable: false })
  })

  it('survives GitHub errors and rejects odd answers', async () => {
    const failing = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    expect((await versionInfo({}, { fetcher: failing })).latest).toBeNull()
    resetUpdateCache()
    const odd = (async () => Response.json({ tag_name: 'latest', html_url: 'https://evil.example/' })) as unknown as typeof fetch
    expect((await versionInfo({}, { fetcher: odd })).latest).toBeNull()
  })
})
