import { describe, expect, it } from 'vitest'
import { bulkLabelChanges, commonLabels, renameLabelChanges, resolveLabel, restoreLabelChanges, undoLabelChanges } from '../src/lib/bulkLabels'

const notes = () => [
  { id: 'a', labels: ['x', 'y'] },
  { id: 'b', labels: ['y'] },
  { id: 'c', labels: ['y', 'z'] },
]

describe('commonLabels', () => {
  it('is empty for no notes', () => {
    expect(commonLabels([])).toEqual([])
  })
  it('keeps only labels on every note', () => {
    expect(commonLabels(notes())).toEqual(['y'])
    expect(commonLabels([{ id: 'a', labels: ['x'] }, { id: 'b', labels: [] }])).toEqual([])
  })
})

describe('bulkLabelChanges', () => {
  it('adds to notes that lack the label, keeping the old labels as previous', () => {
    expect(bulkLabelChanges(notes(), 'x', true)).toEqual([
      { id: 'b', labels: ['y', 'x'], previous: ['y'] },
      { id: 'c', labels: ['y', 'z', 'x'], previous: ['y', 'z'] },
    ])
  })
  it('removes only from notes that have it', () => {
    expect(bulkLabelChanges(notes(), 'z', false)).toEqual([{ id: 'c', labels: ['y'], previous: ['y', 'z'] }])
    expect(bulkLabelChanges(notes(), 'none', false)).toEqual([])
  })
  it('does not mutate the input, and previous restores the originals', () => {
    const input = notes()
    const changes = bulkLabelChanges(input, 'x', true)
    expect(input).toEqual(notes())
    const restored = input.map((n) => ({ ...n, labels: changes.find((c) => c.id === n.id)?.previous ?? n.labels }))
    expect(restored).toEqual(notes())
  })
})

describe('undoLabelChanges', () => {
  const byId = (list: { id: string; labels: string[] }[]) => (id: string) => list.find((n) => n.id === id)
  const apply = (list: { id: string; labels: string[] }[], changes: { id: string; labels: string[] }[]) =>
    list.map((n) => ({ ...n, labels: changes.find((c) => c.id === n.id)?.labels ?? n.labels }))

  it('restores the exact previous labels of untouched notes, for add and remove', () => {
    for (const [label, add] of [['x', true], ['y', false]] as const) {
      const changes = bulkLabelChanges(notes(), label, add)
      const after = apply(notes(), changes)
      expect(apply(after, undoLabelChanges(changes, byId(after), label, add))).toEqual(notes())
    }
  })
  it('keeps labels changed after the batch and skips notes that are gone', () => {
    const first = bulkLabelChanges(notes(), 'x', true)
    const mid = apply(notes(), first)
    const later = apply(mid, bulkLabelChanges(mid, 'w', true)).filter((n) => n.id !== 'c')
    const undone = apply(later, undoLabelChanges(first, byId(later), 'x', true))
    expect(undone).toEqual([
      { id: 'a', labels: ['x', 'y', 'w'] },
      { id: 'b', labels: ['y', 'w'] },
    ])
  })
})

describe('renaming a label', () => {
  const note = (id: string, labels: string[]) => ({ id, labels })

  it('puts the new name in the old one’s place and keeps what it replaced', () => {
    const a = note('a', ['x', 'work', 'y'])
    const [c, ...rest] = renameLabelChanges([a], 'work', 'job')
    expect(rest).toEqual([])
    expect(c).toEqual({ id: 'a', labels: ['x', 'job', 'y'], previous: ['x', 'work', 'y'] })
  })

  it('merges into an existing label without a duplicate and leaves other notes out', () => {
    const both = note('both', ['work', 'job'])
    const only = note('only', ['work'])
    const other = note('other', ['job'])
    const changes = renameLabelChanges([both, only, other], 'work', 'job')
    expect(changes.map((c) => [c.id, c.labels])).toEqual([['both', ['job']], ['only', ['job']]])
  })

  it('does nothing when the name is the same', () => {
    expect(renameLabelChanges([note('a', ['x'])], 'x', 'x')).toEqual([])
  })

  it('restores untouched notes, skipping changed and missing ones', () => {
    const notes = [note('a', ['w']), note('b', ['w']), note('c', ['w'])]
    const changes = renameLabelChanges(notes, 'w', 'j')
    const now = new Map([['a', note('a', ['j'])], ['b', note('b', ['j', 'new'])]])
    const undo = restoreLabelChanges(changes, (id) => now.get(id))
    expect(undo.map((c) => [c.id, c.labels])).toEqual([['a', ['w']]])
  })

  it('resolves the spelling to an existing label, trimmed', () => {
    expect(resolveLabel('  work ', ['Work', 'Home'], 'old')).toBe('Work')
    expect(resolveLabel(' fresh ', ['Work'], 'old')).toBe('fresh')
    expect(resolveLabel('work', ['Work'], 'Work')).toBe('work')
  })

  it('deletes a label and undoes it', () => {
    const notes = [note('a', ['x', 'y']), note('b', ['z'])]
    const changes = bulkLabelChanges(notes, 'x', false)
    expect(changes.map((c) => [c.id, c.labels])).toEqual([['a', ['y']]])
    const undo = undoLabelChanges(changes, () => note('a', ['y']), 'x', false)
    expect(undo[0].labels).toEqual(['x', 'y'])
  })
})
