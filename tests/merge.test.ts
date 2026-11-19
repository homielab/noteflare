import { describe, expect, it } from 'vitest'
import { mergeNotes, mergeSet, mergeText, type MergeSide } from '../src/lib/sync/merge'

const list = (...lines: string[]) => lines.join('\n')

describe('mergeText', () => {
  const base = list('- [ ] milk', '- [ ] eggs', '- [ ] bread')

  it('keeps a tick from one device and a new item from the other', () => {
    const phone = list('- [ ] milk', '- [ ] eggs', '- [ ] bread', '- [ ] coffee')
    const laptop = list('- [x] milk', '- [ ] eggs', '- [ ] bread')
    expect(mergeText(base, phone, laptop)).toBe(list('- [x] milk', '- [ ] eggs', '- [ ] bread', '- [ ] coffee'))
  })

  it('applies edits to different lines from both sides', () => {
    const a = list('- [ ] whole milk', '- [ ] eggs', '- [ ] bread')
    const b = list('- [ ] milk', '- [ ] eggs', '- [ ] sourdough')
    expect(mergeText(base, a, b)).toBe(list('- [ ] whole milk', '- [ ] eggs', '- [ ] sourdough'))
  })

  it('handles a deletion on one side and an edit elsewhere on the other', () => {
    const a = list('- [ ] milk', '- [ ] bread')
    const b = list('- [ ] milk', '- [ ] eggs', '- [x] bread')
    expect(mergeText(base, a, b)).toBe(list('- [ ] milk', '- [x] bread'))
  })

  it('keeps both when both devices add lines at the same spot', () => {
    const a = list('- [ ] milk', '- [ ] eggs', '- [ ] bread', '- [ ] tea')
    const b = list('- [ ] milk', '- [ ] eggs', '- [ ] bread', '- [ ] rice')
    expect(mergeText(base, a, b)).toBe(list('- [ ] milk', '- [ ] eggs', '- [ ] bread', '- [ ] tea', '- [ ] rice'))
  })

  it('ticks the last item on one device and appends an item on the other', () => {
    const ticked = list('- [ ] milk', '- [ ] eggs', '- [x] bread')
    const appended = list('- [ ] milk', '- [ ] eggs', '- [ ] bread', '- [ ] coffee')
    const merged = list('- [ ] milk', '- [ ] eggs', '- [x] bread', '- [ ] coffee')
    expect(mergeText(base, ticked, appended)).toBe(merged)
    expect(mergeText(base, appended, ticked)).toBe(merged)
  })

  it('accepts identical edits made on both devices', () => {
    const a = list('- [x] milk', '- [ ] eggs', '- [ ] bread')
    expect(mergeText(base, a, a)).toBe(a)
  })

  it('reports a conflict when both change the same line differently', () => {
    const a = list('- [ ] oat milk', '- [ ] eggs', '- [ ] bread')
    const b = list('- [ ] soy milk', '- [ ] eggs', '- [ ] bread')
    expect(mergeText(base, a, b)).toBeNull()
  })
})

describe('mergeSet', () => {
  it('keeps additions from both sides and honours removals', () => {
    expect(mergeSet(['work', 'old'], ['work', 'urgent'], ['work', 'old', 'q4'])).toEqual(['work', 'q4', 'urgent'])
  })
})

describe('mergeNotes', () => {
  const base: MergeSide = { title: 'Groceries', body: 'milk', color: 'default', labels: [], pinned: false, archived: false, trashedAt: null, position: 1 }

  it('keeps unknown fields per key, like the small flags', () => {
    const withExtra = { ...base, extra: { a: { n: 1 }, b: 'x' } }
    // Changed on one side only: kept, whichever side.
    expect(mergeNotes(withExtra, { ...withExtra, title: 'T' }, { ...withExtra, extra: { a: { n: 2 }, b: 'x' } })).toMatchObject({ title: 'T', extra: { a: { n: 2 }, b: 'x' } })
    expect(mergeNotes(withExtra, { ...withExtra, extra: { a: { n: 1 }, b: 'y' } }, { ...withExtra, body: 'eggs' })?.extra).toEqual({ a: { n: 1 }, b: 'y' })
    // Equal values from separate parses count as unchanged; added on one side is kept.
    expect(mergeNotes(withExtra, { ...withExtra, extra: { a: { n: 1 }, b: 'x' } }, { ...withExtra, extra: { a: { n: 1 }, b: 'x', c: true } })?.extra).toEqual({ a: { n: 1 }, b: 'x', c: true })
    // Removed on one side: removed. Both changed: ours wins.
    expect(mergeNotes(withExtra, { ...withExtra, extra: { a: { n: 1 } } }, withExtra)?.extra).toEqual({ a: { n: 1 } })
    expect(mergeNotes(withExtra, { ...withExtra, extra: { b: 'o' } }, { ...withExtra, extra: { b: 't' } })?.extra).toEqual({ b: 'o' })
    expect(mergeNotes(base, { ...base, title: 'T' }, base)?.extra).toBeUndefined()
  })

  it('merges title on one side with body and color on the other', () => {
    const ours = { ...base, title: 'Groceries – Saturday' }
    const theirs = { ...base, body: 'milk\neggs', color: 'sage' as const }
    expect(mergeNotes(base, ours, theirs)).toMatchObject({ title: 'Groceries – Saturday', body: 'milk\neggs', color: 'sage' })
  })

  it('refuses when both renamed the note differently', () => {
    expect(mergeNotes(base, { ...base, title: 'A' }, { ...base, title: 'B' })).toBeNull()
  })

  it('keeps import dates, and drops the edit date when one side dropped it', () => {
    const dated = { ...base, importedCreatedAt: 1, importedUpdatedAt: 2 }
    expect(mergeNotes(dated, { ...dated, title: 'T' }, { ...dated, body: 'milk\neggs' })).toMatchObject({ importedCreatedAt: 1, importedUpdatedAt: 2 })
    expect(mergeNotes(dated, { ...dated, title: 'T' }, { ...dated, importedUpdatedAt: undefined })?.importedUpdatedAt).toBeUndefined()
  })

  it('merges reminder on one side with body edit on the other, and honours removal', () => {
    const ours = { ...base, reminder: 1_700_000_000_000 }
    const theirs = { ...base, body: 'milk\neggs' }
    expect(mergeNotes(base, ours, theirs)).toMatchObject({ reminder: 1_700_000_000_000, body: 'milk\neggs' })

    const withRem = { ...base, reminder: 1_700_000_000_000 }
    const oursRemoved = { ...withRem, reminder: undefined }
    const theirsUnchanged = { ...withRem, body: 'milk\neggs' }
    expect(mergeNotes(withRem, oursRemoved, theirsUnchanged)?.reminder).toBeUndefined()
  })

  it('lets this device win small flag clashes instead of making a copy', () => {
    expect(mergeNotes(base, { ...base, color: 'rose' }, { ...base, color: 'sky' })?.color).toBe('rose')
  })
})
