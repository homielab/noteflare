import type { NoteCardProps, ReorderHandlers } from '@/components/NoteCard'
import type { Note } from './noteModel'

/** How many cards play the unlock "decrypt" animation. */
export const MAX_REVEAL = 18

/** What the board knows that a card's look depends on. */
export interface BoardState {
  editingId: string | null
  focusId: string | null
  dragId: string | null
  overId: string | null
  /** The picked ids in select mode, else null. */
  selected: ReadonlySet<string> | null
  /** Omitted where the order can't change (trash, select mode). */
  reorder?: ReorderHandlers
  /** The unlock animation is still playing. */
  revealing: boolean
}

export type CardHandlers = Pick<NoteCardProps, 'onOpen' | 'onChange' | 'onDeleteForever' | 'onCopy'> & { onSelect: (id: string) => void }

/**
 * The props of one card. `NoteCard` is memoized, so every value here must stay
 * identical for a note that didn't change: primitives, the note itself and
 * handlers from `stableHandlers` — never a closure or object made per render.
 */
export function cardProps(note: Note, index: number, board: BoardState, handlers: CardHandlers): NoteCardProps {
  return {
    note,
    revealIndex: board.revealing && index < MAX_REVEAL ? index : undefined,
    lifted: board.editingId === note.id,
    focused: board.focusId === note.id,
    reorder: board.reorder,
    dragging: board.dragId === note.id,
    dropTarget: board.overId === note.id,
    selecting: board.selected !== null,
    selected: board.selected?.has(note.id) ?? false,
    ...handlers,
  }
}

/**
 * Handlers whose identity never changes while each call runs the newest version
 * (`latest()` is read at call time), so memoized children don't re-render when
 * a handler's inputs change.
 */
export function stableHandlers<T extends Record<string, (...args: never[]) => unknown>>(latest: () => T): T {
  const out: Record<string, unknown> = {}
  for (const name of Object.keys(latest())) out[name] = (...args: never[]) => latest()[name](...args)
  return out as T
}
