import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Note } from '@/lib/notes'
import { disablePush, enablePush, PushBlockedError, pushEnabled, pushSupported, PushUnavailableError } from '@/lib/push'

/** The per-device switch for reminder notifications while the app is closed, with what turning it on shares. */
export function ReminderPushDialog({ open, onOpenChange, notes }: { open: boolean; onOpenChange: (o: boolean) => void; notes: Note[] }) {
  const { t } = useI18n()
  const [on, setOn] = useState(pushEnabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = pushSupported()

  useEffect(() => {
    if (!open) return
    setOn(pushEnabled())
    setError(null)
  }, [open])

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      if (on) {
        await disablePush()
        setOn(false)
        toast(t('push.turnedOff'))
      } else {
        await enablePush(notes)
        setOn(true)
        toast(t('push.turnedOn'))
      }
    } catch (err) {
      setError(err instanceof PushBlockedError ? t('push.blocked') : err instanceof PushUnavailableError ? t('push.unsupported') : t('push.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('push.title')}</DialogTitle>
          <DialogDescription>{t('push.intro')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
          <span id="push-switch-label" className="flex-1 text-sm font-medium">
            {t('push.switch')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="push-switch-label"
            aria-describedby="push-stores"
            disabled={busy || (!supported && !on)}
            onClick={() => void toggle()}
            className={cn(
              'relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
              on ? 'bg-primary' : 'bg-foreground/20',
            )}
          >
            <span aria-hidden className={cn('absolute top-0.5 left-0.5 size-5 rounded-full bg-surface shadow-sm transition-transform', on && 'translate-x-5')} />
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!supported && !error && <p className="text-sm text-muted-foreground">{t('push.unsupported')}</p>}
        <div id="push-stores" className="grid gap-2 text-sm text-muted-foreground">
          <p>{t('push.stores')}</p>
          <p>{t('push.contacts')}</p>
          <p>{t('push.off')}</p>
          <p>{t('push.ios')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
