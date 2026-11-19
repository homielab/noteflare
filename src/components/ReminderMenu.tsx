import React, { useState } from 'react'
import { Bell, BellPlus, BellRing, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { dateLocale, useI18n } from '@/i18n'
import type { Note, NotePatch } from '@/lib/notes'
import { askNotifyPermission, isOverdue, reminderPresets } from '@/lib/reminders'
import { cn } from '@/lib/utils'

export function formatReminder(ms: number, locale = dateLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms))
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface ReminderChipProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  note: Note
  onChange: (patch: NotePatch) => void
  onOpenMenu?: () => void
}

export const ReminderChip = React.forwardRef<HTMLDivElement, ReminderChipProps>(
  ({ note, onChange, onOpenMenu, className, ...props }, ref) => {
    const { t } = useI18n()
    const reminder = note.reminder
    if (!reminder) return null
    const overdue = isOverdue(reminder)
    const formatted = formatReminder(reminder, dateLocale())

    return (
      <div
        ref={ref}
        className={cn('inline-flex items-center gap-1 max-w-full', className)}
        onClick={(e) => {
          e.stopPropagation()
          props.onClick?.(e)
          onOpenMenu?.()
        }}
        {...props}
      >
        <span
          role="button"
          tabIndex={0}
          className={cn(
            'inline-flex max-w-full items-center gap-1 truncate rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs transition-colors hover:bg-foreground/10 cursor-pointer',
            overdue && 'text-destructive',
          )}
          aria-label={overdue ? t('rem.overdue') : undefined}
        >
          {overdue ? <BellRing className="size-3 shrink-0" /> : <Bell className="size-3 shrink-0" />}
          <span className="truncate">{formatted}</span>
        </span>
        <Tooltip label={t('rem.done')}>
          <button
            type="button"
            aria-label={t('rem.done')}
            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onChange({ reminder: undefined })
            }}
          >
            <Check className="size-3" />
          </button>
        </Tooltip>
      </div>
    )
  },
)
ReminderChip.displayName = 'ReminderChip'

interface ReminderMenuProps {
  note: Note
  onChange: (patch: NotePatch) => void
  variant: 'icon' | 'chip'
}

export function ReminderMenu({ note, onChange, variant }: ReminderMenuProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pickingCustom, setPickingCustom] = useState(false)
  const [customDate, setCustomDate] = useState(() =>
    toDatetimeLocal(new Date(note.reminder ?? Date.now() + 3600_000)),
  )

  if (variant === 'chip' && !note.reminder) return null

  const presets = reminderPresets(new Date())

  const choose = (ms: number) => {
    onChange({ reminder: ms })
    askNotifyPermission()
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) {
      setCustomDate(toDatetimeLocal(new Date(note.reminder ?? Date.now() + 3600_000)))
    } else {
      setPickingCustom(false)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      {variant === 'icon' ? (
        <Tooltip label={t('rem.set')}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('rem.set')}
              onClick={(e) => e.stopPropagation()}
            >
              {note.reminder ? <Bell className="size-4" /> : <BellPlus className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>
          <ReminderChip note={note} onChange={onChange} />
        </DropdownMenuTrigger>
      )}

      <DropdownMenuContent align="start" className="w-64" onClick={(e) => e.stopPropagation()}>
        {presets.laterToday !== null && (
          <DropdownMenuItem onSelect={() => choose(presets.laterToday!)}>
            <span>{t('rem.laterToday')}</span>
            <span className="ml-auto text-xs text-muted-foreground">{formatReminder(presets.laterToday)}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => choose(presets.tomorrowMorning)}>
          <span>{t('rem.tomorrow')}</span>
          <span className="ml-auto text-xs text-muted-foreground">{formatReminder(presets.tomorrowMorning)}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => choose(presets.nextWeek)}>
          <span>{t('rem.nextWeek')}</span>
          <span className="ml-auto text-xs text-muted-foreground">{formatReminder(presets.nextWeek)}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!pickingCustom ? (
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPickingCustom(true); }}>
            {t('rem.pick')}
          </DropdownMenuItem>
        ) : (
          <div className="flex items-center gap-1.5 p-1" onClick={(e) => e.stopPropagation()}>
            <input
              type="datetime-local"
              className="h-8 flex-1 rounded border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
            />
            <Button
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={!customDate}
              onClick={(e) => {
                e.stopPropagation()
                const ms = new Date(customDate).getTime()
                if (Number.isFinite(ms) && ms > 0) {
                  choose(ms)
                  setOpen(false)
                  setPickingCustom(false)
                }
              }}
            >
              {t('rem.ok')}
            </Button>
          </div>
        )}
        {note.reminder && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                onChange({ reminder: undefined })
              }}
            >
              {t('rem.remove')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
