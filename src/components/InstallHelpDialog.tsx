import { Share, SquarePlus, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'

/** iPhone and iPad have no install prompt: show the Add to Home Screen steps instead. */
export function InstallHelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n()
  const steps = [
    { icon: <Share />, text: t('ios.step1') },
    { icon: <SquarePlus />, text: t('ios.step2') },
    { icon: <Check />, text: t('ios.step3') },
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <img src="/favicon.svg" alt="" className="mb-1 size-14" />
          <DialogTitle>{t('ios.title')}</DialogTitle>
          <DialogDescription>{t('ios.body')}</DialogDescription>
        </DialogHeader>
        <ol className="grid gap-3">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-3 rounded-xl border p-3 text-sm">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-link [&_svg]:size-5">{s.icon}</span>
              <span>
                <span className="mr-1 font-semibold">{i + 1}.</span>
                {s.text}
              </span>
            </li>
          ))}
        </ol>
        <Button onClick={() => onOpenChange(false)}>{t('ios.done')}</Button>
      </DialogContent>
    </Dialog>
  )
}
