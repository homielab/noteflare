import { describe, expect, it } from 'vitest'
import { cardProps, stableHandlers, type BoardState, type CardHandlers } from '../src/lib/cardProps'
import { emptyNote, type Note } from '../src/lib/noteModel'

const board: BoardState = { editingId: null, focusId: null, dragId: null, overId: null, selected: null, revealing: false }

/** What the notebook does on every render: handlers closing over the current notes. */
function render(byId: Map<string, Note>, opened: Note[]): CardHandlers {
  return {
    onOpen: (id) => void opened.push(byId.get(id)!),
    onChange: () => {},
    onDeleteForever: () => {},
    onCopy: () => {},
    onSelect: () => {},
  }
}

describe('cardProps', () => {
  it("keeps a card's props identical when another note is edited", () => {
    const a = { ...emptyNote(), title: 'a' }
    const b = { ...emptyNote(), title: 'b' }
    const opened: Note[] = []
    let current = render(new Map([[a.id, a], [b.id, b]]), opened)
    const handlers = stableHandlers(() => current)
    const before = cardProps(b, 1, { ...board, editingId: a.id }, handlers)

    // A keystroke in note a: a new map and new closures, as after each save.
    const edited = { ...a, title: 'a!' }
    current = render(new Map([[a.id, edited], [b.id, b]]), opened)
    const after = cardProps(b, 1, { ...board, editingId: a.id }, handlers)

    expect(Object.keys(after)).toEqual(Object.keys(before))
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(Object.is(after[key], before[key]), key).toBe(true)

    // The stable handlers still act on the newest notes.
    after.onOpen(a.id)
    expect(opened).toEqual([edited])
  })

  it('changes only what the board state says about that card', () => {
    const n = emptyNote()
    const handlers = stableHandlers(() => render(new Map(), []))
    expect(cardProps(n, 0, { ...board, editingId: n.id }, handlers).lifted).toBe(true)
    expect(cardProps(n, 0, { ...board, selected: new Set([n.id]) }, handlers)).toMatchObject({ selecting: true, selected: true })
    expect(cardProps(n, 0, { ...board, selected: new Set() }, handlers)).toMatchObject({ selecting: true, selected: false })
    expect(cardProps(n, 0, { ...board, revealing: true }, handlers).revealIndex).toBe(0)
    expect(cardProps(n, 0, board, handlers).revealIndex).toBeUndefined()
  })
})
