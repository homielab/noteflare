import { describe, expect, it } from 'vitest'
import { createVault, encryptNote, unlockWithPassphrase } from '../src/lib/crypto'
import { buildBackup, canDecryptBackup, decryptBackup, InvalidBackupError, markdownEntries, parseBackup, toMarkdownFile } from '../src/lib/exportNotes'
import { parseMarkdown } from '../src/lib/importMarkdown'
import { emptyNote, type Note } from '../src/lib/noteModel'
import { crc32, makeZip } from '../src/lib/zip'

const note = (patch: Partial<Note>): Note => ({ ...emptyNote(), ...patch })
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('Markdown export', () => {
  it('writes frontmatter the importer reads back unchanged', () => {
    const n = note({ title: 'Kế hoạch: "Q4"', body: '- [ ] one\n\n```js\nx\n```', labels: ['work', 'q4'], color: 'sky', pinned: true })
    const back = parseMarkdown('NoteFlare/x.md', toMarkdownFile(n))
    expect(back).toMatchObject({ title: n.title, body: n.body, labels: n.labels, color: 'sky', pinned: true, archived: false })
  })

  it('skips the trash, makes names unique and safe, and turns a slash label into folders', () => {
    const files = markdownEntries([
      note({ title: 'Same' }),
      note({ title: 'same' }),
      note({ title: 'a/b:c' }),
      note({ title: '', body: '# First line\nmore' }),
      note({ title: 'Deep', labels: ['work/q4'] }),
      note({ title: 'Gone', trashedAt: 1 }),
    ]).map((f) => f.name)
    expect(files).toEqual(['NoteFlare/Same.md', 'NoteFlare/same (2).md', 'NoteFlare/a-b-c.md', 'NoteFlare/First line.md', 'NoteFlare/work/q4/Deep.md'])
  })
})

describe('makeZip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes a readable stored archive with UTF-8 names', () => {
    const data = new TextEncoder().encode('xin chào')
    const zip = makeZip([{ name: 'NoteFlare/Ghi chú.md', data, modifiedAt: Date.UTC(2026, 0, 2) }])
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const nameLen = view.getUint16(26, true)
    expect(text(zip.subarray(30, 30 + nameLen))).toBe('NoteFlare/Ghi chú.md')
    expect(text(zip.subarray(30 + nameLen, 30 + nameLen + data.length))).toBe('xin chào')
    // End of central directory: one entry, pointing at the central header.
    const eocd = zip.length - 22
    expect(view.getUint32(eocd, true)).toBe(0x06054b50)
    expect(view.getUint16(eocd + 10, true)).toBe(1)
    expect(view.getUint32(view.getUint32(eocd + 16, true), true)).toBe(0x02014b50)
  })
})

describe('encrypted backup', () => {
  it('restores with the same key, and with the passphrase after the key is gone', async () => {
    const { record, dek } = await createVault('correct horse battery staple')
    const a = note({ title: 'A', body: 'alpha', labels: ['x'], pinned: true, position: 5 })
    const trashed = note({ title: 'T', trashedAt: 1 })
    const rows = await Promise.all(
      [a, trashed].map(async (n) => ({
        ...(await encryptNote(dek, n.id, { title: n.title, body: n.body, color: n.color, labels: n.labels })),
        id: n.id, pinned: n.pinned, archived: n.archived, trashedAt: n.trashedAt, position: n.position, version: 1, createdAt: 1, updatedAt: 2,
      })),
    )
    const file = JSON.stringify(buildBackup(record, rows))
    expect(file).not.toContain('alpha')

    const backup = parseBackup(file)
    expect(await canDecryptBackup(backup, dek)).toBe(true)
    const restored = await decryptBackup(backup, dek)
    expect(restored.failed).toBe(0)
    expect(restored.notes).toHaveLength(1)
    expect(restored.notes[0]).toMatchObject({ title: 'A', body: 'alpha', labels: ['x'], pinned: true, modifiedAt: 5 })

    const other = (await createVault('another passphrase entirely')).dek
    expect(await canDecryptBackup(backup, other)).toBe(false)
    const fromPassphrase = await unlockWithPassphrase(backup.vault, 'correct horse battery staple')
    expect((await decryptBackup(backup, fromPassphrase)).notes[0].title).toBe('A')
  }, 60_000)

  it('rejects files that are not a backup', () => {
    expect(() => parseBackup('nope')).toThrow(InvalidBackupError)
    expect(() => parseBackup('{"format":"other"}')).toThrow(InvalidBackupError)
    expect(() => parseBackup(JSON.stringify({ format: 'noteflare-backup', version: 1, vault: {}, notes: [] }))).toThrow(InvalidBackupError)
  })
})
