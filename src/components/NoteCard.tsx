import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { Note, NotePatch } from '@/lib/notes'
import { toggleTask } from '@/lib/notes'
import { cipherNoise, VT_CLASS, vtName } from '@/lib/motion'
import { NoteMarkdown } from './NoteMarkdown'
import { NoteActions, PinButton } from './NoteActions'
import { colorVar } from './noteColors'
import { useI18n } from '@/i18n'

interface Props {
  note: Note
  /** Position in the unlock "decrypt" animation; undefined = no animation. */
  revealIndex?: number
  /** Open in the editor: hide the card so the editor appears lifted out of the grid. */
  lifted?: boolean
  /** Just closed from the editor: keep the top layer while it settles back into the grid. */
  focused?: boolean
  onOpen: (id: string) => void
  onChange: (id: string, patch: NotePatch, immediate?: boolean) => void
  onDeleteForever: (id: string) => void
}

const reveal =
  'opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'

export const NoteCard = memo(function NoteCard({ note, revealIndex, lifted, focused, onOpen, onChange, onDeleteForever }: Props) {
  const { t } = useI18n()
  const change = (patch: NotePatch) => onChange(note.id, patch, true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  const revealing = revealIndex !== undefined
  const noise = useMemo(() => (revealing ? cipherNoise(900) : ''), [revealing])

  // Fade the bottom only when the content is actually clipped.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [note.body])

  const style = {
    background: colorVar(note.color),
    viewTransitionName: lifted ? 'none' : vtName(note.id),
    viewTransitionClass: focused ? VT_CLASS.editor : VT_CLASS.card,
    '--i': revealIndex ?? 0,
  } as CSSProperties

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={note.title || t('card.untitled')}
      onClick={() => onOpen(note.id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen(note.id)
        }
      }}
      className={cn(
        'paper group relative cursor-default overflow-hidden rounded-2xl border outline-none',
        'transition-[box-shadow,opacity,translate,scale] duration-200 ease-[var(--ease-out)]',
        'hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_14px_28px_-14px_rgb(0_0_0/0.3)] active:scale-[0.985] focus-visible:ring-[3px] focus-visible:ring-ring/50',
        note.color === 'default' ? 'border-border' : 'border-transparent',
        lifted && 'opacity-0',
      )}
      style={style}
    >
      <div className={cn('p-4 pb-2', revealing && 'reveal-content')}>
        <div className={cn('absolute top-2 right-2 z-10', note.pinned ? '' : reveal)}>
          <PinButton note={note} onChange={change} />
        </div>

        {note.title && <h3 className="mb-1.5 pr-8 text-[1.0625rem] font-semibold leading-snug">{note.title}</h3>}

        {note.body ? (
          <div
            ref={bodyRef}
            className={cn('max-h-80 overflow-hidden', clipped && '[mask-image:linear-gradient(to_bottom,black_78%,transparent)]')}
          >
            <NoteMarkdown
              source={note.body}
              onToggleTask={note.trashedAt ? undefined : (i) => change({ body: toggleTask(note.body, i) })}
            />
          </div>
        ) : (
          !note.title && <p className="text-muted-foreground">{t('card.empty')}</p>
        )}

        {note.labels.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {note.labels.map((l) => (
              <li key={l} className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs">
                {l}
              </li>
            ))}
          </ul>
        )}

        <div className={cn('-ml-2 mt-1 flex h-8 items-center gap-0.5', reveal)}>
          <NoteActions note={note} onChange={change} onDeleteForever={() => onDeleteForever(note.id)} />
        </div>
      </div>

      {revealing && (
        <>
          <div aria-hidden className="reveal-cipher">
            {noise}
          </div>
          <div aria-hidden className="reveal-scan" />
        </>
      )}
    </article>
  )
})
