import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { resolveLabel } from '@/lib/bulkLabels'

interface Props {
  label: string | null
  labels: string[]
  onClose: () => void
  onRename: (from: string, to: string) => void
}

/** Rename a label on every note; naming an existing label merges the two. */
export function RenameLabelDialog({ label, labels, onClose, onRename }: Props) {
  const { t } = useI18n()
  const [value, setValue] = useState(label ?? '')
  const [shown, setShown] = useState(label)
  if (label !== shown) {
    setShown(label)
    if (label !== null) setValue(label)
  }

  const from = label ?? shown ?? ''
  const to = resolveLabel(value, labels, from)
  const merges = labels.includes(to) && to !== from
  const trimmed = value.trim()
  const disabled = !trimmed || trimmed === from

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (label === null || disabled) return
    onRename(label, value)
    onClose()
  }

  return (
    <Dialog open={label !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('labels.renameTitle')}</DialogTitle>
          <DialogDescription className="sr-only">{t('labels.renameTitle')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={value}
            maxLength={40}
            aria-label={t('labels.newName')}
            enterKeyHint="done"
            onChange={(e) => setValue(e.target.value)}
          />
          {merges && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('labels.mergeHint', { to })}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={disabled}>
              {t('labels.rename')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
