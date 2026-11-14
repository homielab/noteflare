/**
 * Versions and the changelog. Shared by the Worker, the web app and the
 * release scripts (which run it directly with Node's TypeScript support),
 * so this file must not import anything.
 */

export interface Semver {
  major: number
  minor: number
  patch: number
  /** Pre-release tag, e.g. "beta.1"; empty for a final release. */
  pre: string
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(input: string): Semver | null {
  const m = SEMVER_RE.exec(input.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' }
}

/** Negative when a < b, positive when a > b, 0 when equal. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k]
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1 // 1.0.0 > 1.0.0-beta
  if (!y.pre) return -1
  const xp = x.pre.split('.')
  const yp = y.pre.split('.')
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp.at(i)
    const q = yp.at(i)
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export const isNewer = (candidate: string, current: string) => compareVersions(candidate, current) > 0

export interface ChangelogRelease {
  /** "0.2.0", or "Unreleased". */
  version: string
  /** ISO date (YYYY-MM-DD) or null. */
  date: string | null
  /** Markdown body of the release, without its heading. */
  body: string
}

const HEADING_RE = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/

/**
 * Parses a Keep a Changelog file: every "## [version] - date" heading starts a release.
 * Link reference definitions at the bottom ("[0.1.0]: https://…") are dropped.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let current: { version: string; date: string | null; lines: string[] } | null = null
  const push = () => current && releases.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() })

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const h = HEADING_RE.exec(line)
    if (h) {
      push()
      current = { version: h[1], date: h[2] ?? null, lines: [] }
    } else if (current && !/^\[[^\]]+\]:\s*\S+/.test(line)) {
      current.lines.push(line)
    }
  }
  push()
  return releases
}

/** Releases newer than `since` and no newer than `upTo`, newest first ("Unreleased" excluded). */
export function releasesBetween(releases: ChangelogRelease[], since: string, upTo: string) {
  return releases.filter((r) => parseVersion(r.version) && isNewer(r.version, since) && !isNewer(r.version, upTo))
}

/** What GET /api/version answers. */
export interface VersionInfo {
  /** Version of this deployment. */
  version: string
  /** Whether this deployment checks GitHub for new releases. */
  checkEnabled: boolean
  /** Newest published release, when the check ran and succeeded. */
  latest: LatestRelease | null
  /** True when `latest` is newer than this deployment. */
  updateAvailable: boolean
  /** When the release information was fetched (ms since epoch), or null. */
  checkedAt: number | null
}

export interface LatestRelease {
  version: string
  name: string
  url: string
  publishedAt: string | null
  /** Release notes (Markdown), trimmed to a sensible length. */
  notes: string
}
