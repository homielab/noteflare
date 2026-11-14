import { isNewer, parseVersion, type LatestRelease, type VersionInfo } from '../shared/release'
import { APP_VERSION } from '../shared/version'

export interface UpdateEnv {
  /**
   * GitHub repository to check for new releases ("owner/name"). Defaults to the
   * upstream project; point it at your fork, or set "off" to disable the check.
   */
  UPDATE_CHECK_REPO?: string
}

const DEFAULT_REPO = 'homielab/noteflare'
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const TTL_MS = 6 * 60 * 60 * 1000
const FAIL_TTL_MS = 30 * 60 * 1000
const FORCE_MIN_MS = 60 * 1000
const MAX_NOTES = 6000

let memo: { repo: string; at: number; latest: LatestRelease | null } | null = null

export function updateRepo(env: UpdateEnv): string | null {
  const v = (env.UPDATE_CHECK_REPO ?? DEFAULT_REPO).trim()
  if (!v || /^(off|false|no|0)$/i.test(v)) return null
  return REPO_RE.test(v) ? v : null
}

/**
 * Asks GitHub for the newest published release of the configured repository.
 *
 * Only the Worker talks to GitHub, never the browser, and the request carries
 * nothing about the user. Results are cached in memory and in Cloudflare's
 * cache for 6 hours, so GitHub sees at most a few requests a day per deployment.
 */
export async function versionInfo(
  env: UpdateEnv,
  opts: { force?: boolean; fetcher?: typeof fetch; now?: number } = {},
): Promise<VersionInfo> {
  const { force = false, fetcher = fetch, now = Date.now() } = opts
  const repo = updateRepo(env)
  if (!repo) return { version: APP_VERSION, checkEnabled: false, latest: null, updateAvailable: false, checkedAt: null }

  const stale = !memo || memo.repo !== repo || now - memo.at > (memo.latest ? TTL_MS : FAIL_TTL_MS)
  // "Check now" may skip the cache, but at most once a minute.
  const forced = force && !!memo && now - memo.at > FORCE_MIN_MS
  if (stale || forced) {
    memo = { repo, at: now, latest: await fetchLatest(repo, fetcher, forced) }
  }
  const latest = memo!.latest
  return {
    version: APP_VERSION,
    checkEnabled: true,
    latest,
    updateAvailable: !!latest && isNewer(latest.version, APP_VERSION),
    checkedAt: latest ? memo!.at : null,
  }
}

/** For tests. */
export function resetUpdateCache() {
  memo = null
}

async function fetchLatest(repo: string, fetcher: typeof fetch, fresh: boolean): Promise<LatestRelease | null> {
  try {
    const res = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'NoteFlare-update-check',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cf: fresh ? { cacheTtl: 0 } : { cacheTtl: TTL_MS / 1000, cacheEverything: true },
    } as RequestInit)
    if (!res.ok) return null
    const r = (await res.json()) as Record<string, unknown>
    const tag = typeof r.tag_name === 'string' ? r.tag_name : ''
    const url = typeof r.html_url === 'string' ? r.html_url : ''
    if (!parseVersion(tag) || !url.startsWith('https://github.com/')) return null
    const body = typeof r.body === 'string' ? r.body : ''
    return {
      version: tag.replace(/^v/, ''),
      name: typeof r.name === 'string' && r.name ? r.name : tag,
      url,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
      notes: body.length > MAX_NOTES ? body.slice(0, MAX_NOTES).trimEnd() + '\n\n…' : body,
    }
  } catch {
    return null
  }
}
