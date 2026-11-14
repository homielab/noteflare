import { Check, Palette } from 'lucide-react'
import { NOTE_COLORS, type NoteColor } from '@/lib/crypto'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { colorVar } from './noteColors'

export function ColorPicker({ value, onChange }: { value: NoteColor; onChange: (c: NoteColor) => void }) {
  const { t } = useI18n()
  return (
    <DropdownMenu>
      <Tooltip label={t('act.color')}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('act.color')} onClick={(e) => e.stopPropagation()}>
            <Palette />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="flex w-[11.5rem] flex-wrap gap-1.5 p-2" onClick={(e) => e.stopPropagation()}>
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={t(`color.${c}`)}
            aria-label={t(`color.${c}`)}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
            className="grid size-8 place-items-center rounded-full border-2 border-transparent outline-none transition-transform duration-150 hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-foreground/60"
            style={{ background: colorVar(c), boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--foreground) 14%, transparent)' }}
          >
            {value === c && <Check className="size-4" />}
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
