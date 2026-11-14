import type { NoteColor } from '@/lib/crypto'

export const colorVar = (c: NoteColor) => `var(--note-${c})`
