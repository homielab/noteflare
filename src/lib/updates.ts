import { useCallback, useEffect, useState } from 'react'
import changelogSource from '../../CHANGELOG.md?raw'
import { compareVersions, parseChangelog, releasesBetween, type VersionInfo } from '../../shared/release'
import { APP_VERSION } from '../../shared/version'
import { api } from './api'

export { APP_VERSION }

/** The changelog bundled with this build, newest first. Empty "Unreleased" sections are left out. */
export const CHANGELOG = parseChangelog(changelogSource).filter((r) => r.version !== 'Unreleased' || r.body)

export const REPO_URL = 'https://github.com/homielab/noteflare'
export const DONATE_URL = 'https://ko-fi.com/homielab'
export const ISSUES_URL = `${REPO_URL}/issues/new/choose`
export const UPDATE_GUIDE_URL = `${REPO_URL}#-update`

const SEEN_KEY = 'noteflare:lastSeenVersion'

export type UpdateState =
  | { status: 'idle' | 'checking' }
  | { status: 'error' }
  | { status: 'done'; info: VersionInfo }

/**
 * Checks for a newer release once when the app opens, and on demand.
 * The Worker asks GitHub and caches the answer; the browser never calls GitHub.
 */
export function useUpdates() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })

  const check = useCallback(async (force = false) => {
    setState({ status: 'checking' })
    try {
      const info = await api.version(force)
      setState({ status: 'done', info })
    } catch {
      setState({ status: 'error' })
    }
  }, [])

  useEffect(() => {
    if (navigator.onLine) void check()
  }, [check])

  const updateAvailable = state.status === 'done' && state.info.updateAvailable
  return { state, check, updateAvailable }
}

/**
 * Returns the releases added since this browser last ran NoteFlare, once.
 * The first run on a device records the version and shows nothing.
 */
export function takeNewReleases() {
  let seen: string | null = null
  try {
    seen = localStorage.getItem(SEEN_KEY)
    localStorage.setItem(SEEN_KEY, APP_VERSION)
  } catch {
    return []
  }
  if (!seen || compareVersions(APP_VERSION, seen) <= 0) return []
  return releasesBetween(CHANGELOG, seen, APP_VERSION)
}
