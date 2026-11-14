/**
 * Drag-and-drop ordering. Notes are sorted by `position`, highest first, so moving a note
 * means giving it a position between its new neighbours; no other note has to change.
 */
interface Positioned {
  id: string
  position: number
}

/**
 * The position that puts `movedId` where `targetId` currently is in `ordered`
 * (one section of the board, already sorted for display). Moving down the list lands
 * after the target, moving up (or in from another section) lands before it.
 * Returns null when there is nothing to do.
 */
export function reorderPosition(ordered: readonly Positioned[], movedId: string, targetId: string): number | null {
  if (movedId === targetId) return null
  const to = ordered.findIndex((n) => n.id === targetId)
  if (to < 0) return null
  const from = ordered.findIndex((n) => n.id === movedId)
  const target = ordered[to]

  if (from >= 0 && from < to) {
    const after = ordered[to + 1]
    return after ? (target.position + after.position) / 2 : target.position - 1
  }
  const before = ordered[to - 1]
  return before ? (before.position + target.position) / 2 : target.position + 1
}

/** The neighbour `delta` steps away (-1 = earlier, 1 = later), for keyboard reordering. */
export function neighbourId(ordered: readonly Positioned[], id: string, delta: -1 | 1): string | null {
  const i = ordered.findIndex((n) => n.id === id)
  return i < 0 ? null : (ordered[i + delta]?.id ?? null)
}
