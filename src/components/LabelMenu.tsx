import { useState } from 'react'
import { Check, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { isCoarsePointer } from '@/lib/viewport'

interface Props {
  value: string[]
  allLabels: string[]
  onChange: (labels: string[]) => void
}

export function LabelMenu({ value, allLabels, onChange }: Props) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const q = query.trim()
  const options = [...new Set([...allLabels, ...value])]
    .filter((l) => l.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
  const canCreate = q && !options.some((l) => l.toLowerCase() === q.toLowerCase())

  const toggle = (label: string) =>
    onChange(value.includes(label) ? value.filter((l) => l !== label) : [...value, label])

  return (
    <DropdownMenu onOpenChange={(o) => !o && setQuery('')}>
      <Tooltip label={t('act.labels')}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('act.labels')}>
            <Tag />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="w-60" align="start" side="top" collisionPadding={8}>
        <DropdownMenuLabel>{t('labels.title')}</DropdownMenuLabel>
        <div className="px-1 pb-1">
          <Input
            // On phones, don't pop the keyboard just for picking an existing label.
            autoFocus={!isCoarsePointer()}
            enterKeyHint="done"
            value={query}
            placeholder={t('labels.search')}
            className="h-8"
            maxLength={40}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation() // keep the menu's typeahead from swallowing keystrokes
              if (e.key === 'Enter' && canCreate) {
                toggle(q)
                setQuery('')
              }
            }}
          />
        </div>
        <div className="max-h-[min(14rem,calc(var(--vvh,100dvh)-10rem))] overflow-y-auto overscroll-contain">
          {options.map((l) => (
            <DropdownMenuItem key={l} onSelect={(e) => (e.preventDefault(), toggle(l))}>
              <span className="grid size-4 place-items-center">{value.includes(l) && <Check />}</span>
              {l}
            </DropdownMenuItem>
          ))}
          {canCreate && (
            <DropdownMenuItem onSelect={(e) => (e.preventDefault(), toggle(q), setQuery(''))}>
              <span className="size-4" />
              {t('labels.create', { q })}
            </DropdownMenuItem>
          )}
          {!options.length && !canCreate && <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('labels.none')}</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
