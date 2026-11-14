import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useVault } from '@/lib/vault'
import { WrongSecretError } from '@/lib/crypto'
import { useI18n } from '@/i18n'

const MIN_PASSPHRASE = 10

export function ChangePassphraseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n()
  const { changePassphrase } = useVault()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next.length < MIN_PASSPHRASE) return setError(t('unlock.newTooShort', { n: MIN_PASSPHRASE }))
    if (next !== confirm) return setError(t('pw.mismatch'))
    setBusy(true)
    setError(null)
    try {
      await changePassphrase(current, next)
      toast(t('pw.changed'))
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof WrongSecretError ? t('pw.wrongCurrent') : t('pw.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pw.title')}</DialogTitle>
          <DialogDescription>{t('pw.body')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Input type="password" autoComplete="current-password" aria-label={t('pw.current')} placeholder={t('pw.current')} value={current} onChange={(e) => setCurrent(e.target.value)} />
          <Input type="password" autoComplete="new-password" aria-label={t('pw.new')} placeholder={t('pw.new')} value={next} onChange={(e) => setNext(e.target.value)} />
          <Input type="password" autoComplete="new-password" aria-label={t('pw.repeat')} placeholder={t('pw.repeat')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button type="submit" disabled={busy || !current}>
              {busy ? t('pw.changing') : t('pw.title')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
