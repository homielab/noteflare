import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n, type MessageKey } from '@/i18n'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

const GROUPS: { title: MessageKey; rows: [string[], MessageKey][] }[] = [
  {
    title: 'kb.anywhere',
    rows: [
      [['C'], 'kb.new'],
      [['/'], 'kb.search'],
      [['Alt', '↑ ↓'], 'kb.move'],
      [['?'], 'kb.help'],
    ],
  },
  {
    title: 'kb.inNote',
    rows: [
      [[MOD, 'Enter'], 'kb.close'],
      [['Esc'], 'kb.esc'],
      [['Enter'], 'kb.continue'],
      [['Tab'], 'kb.indent'],
      [[MOD, 'Shift', 'L'], 'kb.checklist'],
    ],
  },
]

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('kb.title')}</DialogTitle>
          <DialogDescription>{t('kb.body')}</DialogDescription>
        </DialogHeader>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t(g.title)}</h3>
            <dl className="divide-y">
              {g.rows.map(([keys, label]) => (
                <div key={label} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <dt>{t(label)}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {keys.map((k) => (
                      <kbd key={k} className="min-w-6 rounded-md border border-b-2 bg-surface px-1.5 py-0.5 text-center font-mono text-xs">
                        {k}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}
