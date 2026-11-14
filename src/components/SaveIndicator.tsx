import { useEffect, useRef, useState } from 'react'
import { CloudOff, KeyRound, LockKeyhole } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dateLocale, useI18n } from '@/i18n'
import { Tooltip } from '@/components/ui/tooltip'
import type { SyncStatus } from '@/lib/notes'

interface Props {
  status: SyncStatus
  onSignIn: () => void
  /** Ask the server for changes now. */
  onSync: () => void
}

const MINUTE = 60_000

/**
 * The sync state in words: what is happening now, or when the server last confirmed
 * everything. Shared by the header indicator and the account menu.
 */
export function useSyncLabel(status: SyncStatus): string {
  const { t } = useI18n()
  // "2 min ago" has to keep counting while nothing else re-renders.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE / 2)
    return () => window.clearInterval(timer)
  }, [])

  if (status.authExpired) return status.pending ? t('save.signInPending', { n: status.pending }) : t('save.signIn')
  if (!status.online) return status.pending ? t('save.offlinePending', { n: status.pending }) : t('save.offline')
  if (status.syncing) return t('save.syncing')
  if (status.pending) return t('save.encrypting')
  if (status.lastSyncedAt === null) return t('save.e2e')
  const minutes = Math.floor(Math.max(0, now - status.lastSyncedAt) / MINUTE)
  if (minutes < 1) return t('save.syncedNow')
  if (minutes < 60) return t('save.syncedMin', { n: minutes })
  return t('save.syncedAt', { time: new Date(status.lastSyncedAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })
}

/**
 * Sync state in the header. The lock breathes while encrypting and pushing and
 * sparks when everything is saved; offline and expired-session states take over
 * when they apply. Clicking it syncs now.
 */
export function SaveIndicator({ status, onSignIn, onSync }: Props) {
  const { t } = useI18n()
  const label = useSyncLabel(status)
  const busy = status.syncing || status.pending > 0
  const [justSaved, setJustSaved] = useState(false)
  const wasBusy = useRef(busy)

  useEffect(() => {
    let timer: number | undefined
    if (wasBusy.current && !busy && status.online && !status.authExpired) {
      setJustSaved(true)
      timer = window.setTimeout(() => setJustSaved(false), 1800)
    }
    wasBusy.current = busy
    return () => window.clearTimeout(timer)
  }, [busy, status.online, status.authExpired])

  if (status.authExpired) {
    return (
      <Tooltip label={t('save.signInHint')}>
        <button
          type="button"
          onClick={onSignIn}
          className="flex h-9 items-center gap-2 rounded-full bg-flare/15 px-3 text-xs font-medium text-foreground outline-none hover:bg-flare/25 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <KeyRound className="size-4 text-flare" />
          <span className="max-md:sr-only">{t('save.signIn')}</span>
          {status.pending > 0 && <span className="tabular-nums text-muted-foreground">{status.pending}</span>}
        </button>
      </Tooltip>
    )
  }

  if (!status.online) {
    return (
      <Tooltip label={t('save.offlineHint')}>
        <button
          type="button"
          onClick={onSync}
          aria-live="polite"
          className="flex h-9 items-center gap-2 rounded-full bg-muted px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <CloudOff className="size-4" />
          <span className="max-md:sr-only">{label}</span>
          {status.pending > 0 && <span className="tabular-nums md:hidden">{status.pending}</span>}
        </button>
      </Tooltip>
    )
  }

  return (
    <Tooltip label={busy ? label : `${label} · ${t('save.syncNow')}`}>
      <button
        type="button"
        onClick={onSync}
        aria-live="polite"
        className="flex h-9 items-center gap-2 rounded-full px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="relative grid size-5 place-items-center">
          <LockKeyhole className={cn('size-4', busy && 'breathe text-flare')} />
          {justSaved && (
            <svg viewBox="0 0 12 12" className="glint absolute -top-1 -right-1.5 size-3 text-flare" aria-hidden>
              <path d="M6 0c.4 2.4 1.6 3.6 6 6-4.4 2.4-5.6 3.6-6 6-.4-2.4-1.6-3.6-6-6 4.4-2.4 5.6-3.6 6-6z" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="max-md:sr-only">{justSaved ? t('save.saved') : label}</span>
      </button>
    </Tooltip>
  )
}
