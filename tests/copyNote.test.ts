import { describe, expect, it } from 'vitest'
import { attachmentIds } from '../src/lib/attachments'
import { copyNote, emptyNote, type Note } from '../src/lib/noteModel'

const ID = '11111111-2222-4333-8444-555555555555'

describe('copyNote', () => {
  const original = {
    ...emptyNote(),
    title: 'T',
    body: `text ![a](/api/blobs/${ID})`,
    color: 'blue' as Note['color'],
    labels: ['x'],
    pinned: true,
    trashedAt: null,
    version: 5,
  }

  it('copies the content into a fresh, unpinned note', () => {
    const c = copyNote(original)
    expect(c.id).not.toBe(original.id)
    expect([c.title, c.body, c.color]).toEqual([original.title, original.body, original.color])
    expect(c.labels).toEqual(original.labels)
    expect(c.labels).not.toBe(original.labels)
    expect(c.pinned).toBe(false)
    expect(c.trashedAt).toBeNull()
    expect(c.version).toBe(0)
  })

  it('keeps the images when the copy is deleted while the original uses them', () => {
    const c = copyNote(original)
    const mine = attachmentIds(c.body)
    const used = new Set([original].flatMap((n) => attachmentIds(n.body)))
    expect(mine).toEqual([ID])
    expect(mine.filter((a) => !used.has(a))).toEqual([])
  })
})
