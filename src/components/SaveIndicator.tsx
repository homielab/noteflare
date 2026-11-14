import { useEffect, useRef, useState } from 'react'
import { CloudOff, KeyRound, LockKeyhole } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { Tooltip } from '@/components/ui/tooltip'
import type { SyncStatus } from '@/lib/notes'

interface Props {
  status: SyncStatus
  onSignIn: () => void
}

/**
 * Sync state in the header. The lock breathes while encrypting and pushing and
 * sparks when everything is saved; offline and expired-session states take over
 * when they apply.
 */
export function SaveIndicator({ status, onSignIn }: Props) {
  const { t } = useI18n()
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
    const label = status.pending ? t('save.offlinePending', { n: status.pending }) : t('save.offline')
    return (
      <Tooltip label={t('save.offlineHint')}>
        <div role="status" aria-live="polite" className="flex h-9 items-center gap-2 rounded-full bg-muted px-3 text-xs text-muted-foreground">
          <CloudOff className="size-4" />
          <span className="max-md:sr-only">{label}</span>
          {status.pending > 0 && <span className="tabular-nums md:hidden">{status.pending}</span>}
        </div>
      </Tooltip>
    )
  }

  const label = busy ? (status.syncing ? t('save.syncing') : t('save.encrypting')) : justSaved ? t('save.saved') : t('save.e2e')
  return (
    <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground" role="status" aria-live="polite">
      <span className="relative grid size-5 place-items-center">
        <LockKeyhole className={cn('size-4', busy && 'breathe text-flare')} />
        {justSaved && (
          <svg viewBox="0 0 12 12" className="glint absolute -top-1 -right-1.5 size-3 text-flare" aria-hidden>
            <path d="M6 0c.4 2.4 1.6 3.6 6 6-4.4 2.4-5.6 3.6-6 6-.4-2.4-1.6-3.6-6-6 4.4-2.4 5.6-3.6 6-6z" fill="currentColor" />
          </svg>
        )}
      </span>
      <span className="max-md:sr-only">{label}</span>
    </div>
  )
}
