import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Note, NotePatch } from '@/lib/notes'
import { toggleTask } from '@/lib/notes'
import { cipherNoise, VT_CLASS, vtName } from '@/lib/motion'
import { remeasure, skipWhenOffscreen } from '@/lib/offscreen'
import { NoteMarkdown } from './NoteMarkdown'
import { NoteActions, PinButton } from './NoteActions'
import { colorVar } from './noteColors'
import { useI18n } from '@/i18n'

export interface NoteCardProps {
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
  onCopy: (note: Note) => void
  /** Drag-and-drop reordering; omitted where the order can't change (trash). */
  reorder?: ReorderHandlers
  /** This card is being dragged. */
  dragging?: boolean
  /** Another card is being dragged over this one. */
  dropTarget?: boolean
  /** Select mode: a click picks the card instead of opening it. */
  selecting?: boolean
  /** This card is picked (select mode). */
  selected?: boolean
  onSelect?: (id: string) => void
}

export interface ReorderHandlers {
  onDragStart: (id: string) => void
  onDragOver: (id: string) => void
  onDrop: (id: string) => void
  onDragEnd: () => void
  /** Keyboard: move one place earlier (-1) or later (1). */
  onMove: (id: string, delta: -1 | 1) => void
}

/** Marks a drag as a note being reordered, so it is never mistaken for dropped files. */
export const NOTE_DRAG_TYPE = 'application/x-noteflare-note'
const isNoteDrag = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types).includes(NOTE_DRAG_TYPE)

const reveal =
  'opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'

export const NoteCard = memo(function NoteCard({ note, revealIndex, lifted, focused, onOpen, onChange, onDeleteForever, onCopy, reorder, dragging, dropTarget, selecting, selected, onSelect }: NoteCardProps) {
  const { t } = useI18n()
  const activate = () => (selecting ? onSelect?.(note.id) : onOpen(note.id))
  const change = (patch: NotePatch) => onChange(note.id, patch, true)
  const cardRef = useRef<HTMLElement>(null)
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

  useEffect(() => skipWhenOffscreen(cardRef.current!), [])
  // New content, new height: measure before the card may be skipped again.
  useEffect(() => remeasure(cardRef.current!), [note.title, note.body, note.labels])

  const style = {
    background: colorVar(note.color),
    // The name applies only while `transition()` marks the card (index.css).
    '--vt': vtName(note.id),
    viewTransitionName: lifted ? 'none' : undefined,
    viewTransitionClass: focused ? VT_CLASS.editor : VT_CLASS.card,
    '--i': revealIndex ?? 0,
  } as CSSProperties

  return (
    <article
      ref={cardRef}
      role="button"
      data-note={note.id}
      tabIndex={0}
      aria-label={note.title || t('card.untitled')}
      aria-pressed={selecting ? !!selected : undefined}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        } else if (reorder && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
          e.preventDefault()
          reorder.onMove(note.id, -1)
        } else if (reorder && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
          e.preventDefault()
          reorder.onMove(note.id, 1)
        }
      }}
      aria-keyshortcuts={reorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      draggable={!!reorder}
      onDragStart={
        reorder &&
        ((e) => {
          e.dataTransfer.setData(NOTE_DRAG_TYPE, note.id)
          e.dataTransfer.effectAllowed = 'move'
          reorder.onDragStart(note.id)
        })
      }
      onDragOver={
        reorder &&
        ((e) => {
          if (!isNoteDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          reorder.onDragOver(note.id)
        })
      }
      onDrop={
        reorder &&
        ((e) => {
          if (!isNoteDrag(e)) return
          e.preventDefault()
          reorder.onDrop(note.id)
        })
      }
      onDragEnd={reorder && (() => reorder.onDragEnd())}
      className={cn(
        'paper group relative cursor-pointer overflow-hidden rounded-2xl border outline-none',
        'transition-[box-shadow,opacity,translate,scale] duration-200 ease-[var(--ease-out)]',
        'hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_14px_28px_-14px_rgb(0_0_0/0.3)] active:scale-[0.985] focus-visible:ring-[3px] focus-visible:ring-ring/50',
        note.color === 'default' ? 'border-border' : 'border-transparent',
        lifted && 'opacity-0',
        dragging && 'opacity-40',
        dropTarget && 'ring-[3px] ring-ring/60',
        selected && 'ring-[3px] ring-primary',
      )}
      style={style}
    >
      <div className={cn('p-4 pb-2', revealing && 'reveal-content')}>
        {selecting ? (
          <span
            aria-hidden
            className={cn(
              'absolute top-2.5 right-2.5 z-10 grid size-6 place-items-center rounded-full border-2 transition-colors',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/30 bg-background/60',
            )}
          >
            {selected && <Check className="size-4" />}
          </span>
        ) : (
          <div className={cn('absolute top-2 right-2 z-10', note.pinned ? '' : reveal)}>
            <PinButton note={note} onChange={change} />
          </div>
        )}

        {note.title && <h3 className="mb-1.5 pr-8 text-[1.0625rem] font-semibold leading-snug">{note.title}</h3>}

        {note.body ? (
          <div
            ref={bodyRef}
            className={cn('max-h-80 overflow-hidden', clipped && '[mask-image:linear-gradient(to_bottom,black_78%,transparent)]')}
          >
            <NoteMarkdown
              source={note.body}
              onToggleTask={note.trashedAt || selecting ? undefined : (i) => change({ body: toggleTask(note.body, i) })}
            />
          </div>
        ) : (
          !note.title && <p className="text-muted-foreground">{t('card.empty')}</p>
        )}

        {note.labels.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {note.labels.map((l) => (
              <li key={l} title={l} className="max-w-full truncate rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs">
                {l}
              </li>
            ))}
          </ul>
        )}

        {selecting ? (
          <div className="h-2" />
        ) : (
          <div className={cn('-ml-2 mt-1 flex h-8 items-center gap-0.5', reveal)}>
            <NoteActions note={note} onChange={change} onDeleteForever={() => onDeleteForever(note.id)} onCopy={() => onCopy(note)} />
          </div>
        )}
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
