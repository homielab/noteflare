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

  it('merges title on one side with body and color on the other', () => {
    const ours = { ...base, title: 'Groceries – Saturday' }
    const theirs = { ...base, body: 'milk\neggs', color: 'sage' as const }
    expect(mergeNotes(base, ours, theirs)).toMatchObject({ title: 'Groceries – Saturday', body: 'milk\neggs', color: 'sage' })
  })

  it('refuses when both renamed the note differently', () => {
    expect(mergeNotes(base, { ...base, title: 'A' }, { ...base, title: 'B' })).toBeNull()
  })

  it('lets this device win small flag clashes instead of making a copy', () => {
    expect(mergeNotes(base, { ...base, color: 'rose' }, { ...base, color: 'sky' })?.color).toBe('rose')
  })
})
