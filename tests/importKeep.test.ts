import { describe, expect, it } from 'vitest'
import { parseKeepNote } from '../src/lib/importKeep'
import { isImportablePath, isKeepPath } from '../src/lib/importMarkdown'

const keep = (o: object) => JSON.stringify({ isTrashed: false, isArchived: false, isPinned: false, ...o })

describe('parseKeepNote', () => {
  it('reads a text note with labels, color, pin and edit time', () => {
    const n = parseKeepNote(
      'Takeout/Keep/Trip.json',
      keep({ title: 'Trip', textContent: 'Book flights\r\nPack', labels: [{ name: 'travel' }], color: 'BLUE', isPinned: true, userEditedTimestampUsec: 1700000000000000 }),
    )
    expect(n).toMatchObject({ title: 'Trip', body: 'Book flights\nPack', labels: ['travel'], color: 'sky', pinned: true, archived: false })
    expect(n?.modifiedAt).toBe(1700000000000)
  })

  it('turns a list note into a checklist', () => {
    const n = parseKeepNote('a.json', keep({ title: 'Shop', listContent: [{ text: 'Milk', isChecked: true }, { text: 'Eggs', isChecked: false }] }))
    expect(n?.body).toBe('- [x] Milk\n- [ ] Eggs')
  })

  it('appends link previews that the text does not already contain', () => {
    const n = parseKeepNote(
      'a.json',
      keep({ textContent: 'see https://a.example', annotations: [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: 'B [x]' }, { url: 'javascript:alert(1)' }] }),
    )
    expect(n?.body).toBe('see https://a.example\n\n[B x](https://b.example)')
  })

  it('skips trashed notes, empty notes, and JSON that is not a Keep note', () => {
    expect(parseKeepNote('a.json', keep({ title: 'x', textContent: 'y', isTrashed: true }))).toBeNull()
    expect(parseKeepNote('a.json', keep({ title: '', textContent: '  ' }))).toBeNull()
    expect(parseKeepNote('package.json', '{"name":"x","version":"1.0.0"}')).toBeNull()
    expect(parseKeepNote('a.json', 'not json')).toBeNull()
    expect(parseKeepNote('a.json', '[]')).toBeNull()
  })

  it('never pins an archived note and falls back to the default color', () => {
    const n = parseKeepNote('a.json', keep({ title: 't', textContent: 'b', isPinned: true, isArchived: true, color: 'DEFAULT' }))
    expect(n).toMatchObject({ pinned: false, archived: true, color: 'default' })
  })
})

describe('import paths', () => {
  it('accepts Markdown and JSON, but not tool folders', () => {
    expect(isImportablePath('Takeout/Keep/a.json')).toBe(true)
    expect(isKeepPath('Takeout/Keep/a.json')).toBe(true)
    expect(isImportablePath('Vault/a.md')).toBe(true)
    expect(isKeepPath('Vault/a.md')).toBe(false)
    expect(isImportablePath('Vault/node_modules/x/package.json')).toBe(false)
    expect(isImportablePath('Takeout/Keep/a.html')).toBe(false)
  })
})
