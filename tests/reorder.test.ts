import { describe, expect, it } from 'vitest'
import { neighbourId, reorderPosition } from '../src/lib/reorder'

// Displayed order: highest position first.
const list = [
  { id: 'a', position: 40 },
  { id: 'b', position: 30 },
  { id: 'c', position: 20 },
  { id: 'd', position: 10 },
]
const order = (movedId: string, position: number) =>
  list.map((n) => (n.id === movedId ? { ...n, position } : n)).sort((x, y) => y.position - x.position).map((n) => n.id).join('')

describe('reorderPosition', () => {
  it('moving down lands after the target', () => {
    expect(order('a', reorderPosition(list, 'a', 'c')!)).toBe('bcad')
    expect(order('a', reorderPosition(list, 'a', 'd')!)).toBe('bcda')
  })
  it('moving up lands before the target', () => {
    expect(order('d', reorderPosition(list, 'd', 'b')!)).toBe('adbc')
    expect(order('d', reorderPosition(list, 'd', 'a')!)).toBe('dabc')
  })
  it('a note from another section lands before the target', () => {
    expect(reorderPosition(list, 'x', 'b')).toBe(35)
    expect(reorderPosition(list, 'x', 'a')).toBe(41)
  })
  it('does nothing for the same note or an unknown target', () => {
    expect(reorderPosition(list, 'a', 'a')).toBeNull()
    expect(reorderPosition(list, 'a', 'zz')).toBeNull()
  })
})

describe('neighbourId', () => {
  it('finds the note one step earlier or later', () => {
    expect(neighbourId(list, 'b', -1)).toBe('a')
    expect(neighbourId(list, 'b', 1)).toBe('c')
    expect(neighbourId(list, 'a', -1)).toBeNull()
    expect(neighbourId(list, 'zz', 1)).toBeNull()
  })
})
